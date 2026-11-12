import { Migration } from '@mikro-orm/migrations';

export class Migration202611120003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      drop trigger wallet_consistency on wagering.wallets;
      drop trigger journal_consistency on wagering.journal;
      drop trigger opening_consistency on wagering.openings;
      drop trigger outbox_consistency on wagering.outbox;
      drop trigger openings_immutable on wagering.openings;
      drop view wagering.wallet_ledger;
      alter table wagering.openings rename to transactions;
      alter table wagering.transactions drop constraint openings_wallet_id_key;
      alter table wagering.transactions drop constraint openings_kind_check;
      alter table wagering.transactions drop constraint openings_status_check;
      alter table wagering.transactions drop constraint openings_amount_check;
      alter table wagering.transactions alter column kind drop default;
      alter table wagering.transactions alter column status set default 'PENDING';
      alter table wagering.transactions add constraint transaction_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'));
      alter table wagering.transactions add constraint transaction_status check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));
      alter table wagering.transactions add constraint opening_processed_positive check (kind <> 'OPENING' or (status = 'PROCESSED' and amount > 0));
      create unique index one_opening_per_wallet on wagering.transactions(wallet_id) where kind = 'OPENING';
      create trigger transactions_immutable before update or delete or truncate on wagering.transactions for each statement execute function wagering.immutable_record();
      alter table wagering.outbox drop constraint outbox_event_type_check;
      alter table wagering.outbox drop constraint outbox_check;
      alter table wagering.outbox add constraint event_type_nonempty check (length(event_type) > 0);
      alter table wagering.outbox add constraint event_payload_object check (jsonb_typeof(payload) = 'object');

      create function wagering.assert_wallet_chain(target uuid) returns void language plpgsql as $$
      declare w wagering.wallets; last_entry wagering.journal;
      begin
        select * into strict w from wagering.wallets where id = target;
        if not exists(select from wagering.accounts where id = w.account_id and kind = 'PLAYER') then
          raise exception 'PLAYER_ACCOUNT_REQUIRED' using errcode = '23514';
        end if;
        select * into last_entry from wagering.journal where wallet_id = target order by wallet_version desc limit 1;
        if last_entry.id is null then
          if w.balance <> 0 or w.version <> 1 then raise exception 'JOURNAL_REQUIRED' using errcode = '23514'; end if;
        elsif (w.balance, w.version) is distinct from (last_entry.balance_after, last_entry.wallet_version) then
          raise exception 'WALLET_JOURNAL_MISMATCH' using errcode = '23514';
        end if;
      end $$;
      create function wagering.assert_transaction_journal(target uuid) returns void language plpgsql as $$
      declare t wagering.transactions; has_journal boolean;
      begin
        select * into strict t from wagering.transactions where id = target;
        has_journal := exists(select from wagering.journal where transaction_id = target);
        if has_journal <> (t.status = 'PROCESSED' and t.kind <> 'LOSS' and t.amount > 0) then
          raise exception 'TRANSACTION_JOURNAL_MISMATCH' using errcode = '23514';
        end if;
      end $$;
      create function wagering.assert_journal_chain(target uuid) returns void language plpgsql as $$
      declare j wagering.journal; previous_entry wagering.journal; next_entry wagering.journal;
        w wagering.wallets; t wagering.transactions; is_credit boolean; counterpart uuid;
      begin
        select * into strict j from wagering.journal where id = target;
        select * into strict w from wagering.wallets where id = j.wallet_id;
        select * into strict t from wagering.transactions where id = j.transaction_id;
        if t.status <> 'PROCESSED' or t.kind = 'LOSS' then raise exception 'TRANSACTION_NOT_FINANCIAL' using errcode = '23514'; end if;
        if w.account_id not in (j.debit_account_id, j.credit_account_id) then raise exception 'PLAYER_PARTY_REQUIRED' using errcode = '23514'; end if;
        is_credit := j.credit_account_id = w.account_id;
        if (t.kind = 'BET' and is_credit) or (t.kind in ('WIN','REFUND') and not is_credit) then
          raise exception 'TRANSACTION_DIRECTION_MISMATCH' using errcode = '23514';
        end if;
        counterpart := case when is_credit then j.debit_account_id else j.credit_account_id end;
        if not exists(select from wagering.accounts where id = counterpart and kind = case when t.kind = 'OPENING' then 'OPENING' else 'GAMING' end)
          or j.balance_after <> j.balance_before + (case when is_credit then j.amount else -j.amount end) then
          raise exception 'UNBALANCED_JOURNAL' using errcode = '23514';
        end if;
        select * into previous_entry from wagering.journal where wallet_id = j.wallet_id and wallet_version < j.wallet_version order by wallet_version desc limit 1;
        if t.kind = 'OPENING' then
          if not is_credit or j.wallet_version <> 1 or j.balance_before <> 0 then raise exception 'INVALID_OPENING' using errcode = '23514'; end if;
        elsif previous_entry.id is null then
          if j.wallet_version <> 2 or j.balance_before <> 0 then raise exception 'INVALID_CHAIN_BASE' using errcode = '23514'; end if;
        elsif (j.wallet_version, j.balance_before) is distinct from (previous_entry.wallet_version + 1, previous_entry.balance_after) then
          raise exception 'BROKEN_JOURNAL_CHAIN' using errcode = '23514';
        end if;
        select * into next_entry from wagering.journal where wallet_id = j.wallet_id and wallet_version > j.wallet_version order by wallet_version limit 1;
        if next_entry.id is not null and (next_entry.wallet_version, next_entry.balance_before) is distinct from (j.wallet_version + 1, j.balance_after) then
          raise exception 'BROKEN_JOURNAL_CHAIN' using errcode = '23514';
        end if;
        if not exists(select from wagering.outbox where transaction_id = j.transaction_id and aggregate_id = j.wallet_id and event_type = 'WalletBalanceChanged') then
          raise exception 'BALANCE_EVENT_REQUIRED' using errcode = '23514';
        end if;
        perform wagering.assert_wallet_chain(j.wallet_id);
      end $$;
      create function wagering.check_wallet_chain() returns trigger language plpgsql as $$
      begin perform wagering.assert_wallet_chain(new.id); return null; end $$;
      create function wagering.check_journal_chain() returns trigger language plpgsql as $$
      begin perform wagering.assert_journal_chain(new.id); return null; end $$;
      create function wagering.check_transaction_journal() returns trigger language plpgsql as $$
      begin perform wagering.assert_transaction_journal(new.id); return null; end $$;
      create function wagering.check_balance_event() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'WalletBalanceChanged' and not exists(select from wagering.journal where transaction_id = new.transaction_id and wallet_id = new.aggregate_id) then
          raise exception 'BALANCE_EVENT_WITHOUT_JOURNAL' using errcode = '23514';
        end if;
        return null;
      end $$;
      create constraint trigger wallet_consistency after insert or update on wagering.wallets deferrable initially deferred for each row execute function wagering.check_wallet_chain();
      create constraint trigger journal_consistency after insert on wagering.journal deferrable initially deferred for each row execute function wagering.check_journal_chain();
      create constraint trigger transaction_consistency after insert on wagering.transactions deferrable initially deferred for each row execute function wagering.check_transaction_journal();
      create constraint trigger outbox_consistency after insert on wagering.outbox deferrable initially deferred for each row execute function wagering.check_balance_event();
      create view wagering.wallet_ledger as
        select j.id, j.wallet_id, j.transaction_id, t.kind,
          case when j.credit_account_id = w.account_id then 'CREDIT' else 'DEBIT' end as direction,
          j.amount, j.currency, j.balance_before, j.balance_after, j.wallet_version, j.created_at
        from wagering.journal j join wagering.wallets w on w.id = j.wallet_id join wagering.transactions t on t.id = j.transaction_id;
      grant select on wagering.wallet_ledger to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`
      do $$ begin
        if exists(select from wagering.transactions where kind <> 'OPENING') then
          raise exception 'Cannot downgrade financial data to opening-only schema';
        end if;
      end $$;
      drop trigger wallet_consistency on wagering.wallets;
      drop trigger journal_consistency on wagering.journal;
      drop trigger transaction_consistency on wagering.transactions;
      drop trigger outbox_consistency on wagering.outbox;
      drop trigger transactions_immutable on wagering.transactions;
      drop view wagering.wallet_ledger;
      drop function wagering.check_wallet_chain(), wagering.check_journal_chain(), wagering.check_transaction_journal(), wagering.check_balance_event();
      drop function wagering.assert_wallet_chain(uuid), wagering.assert_journal_chain(uuid), wagering.assert_transaction_journal(uuid);
      drop index wagering.one_opening_per_wallet;
      alter table wagering.transactions drop constraint transaction_kind;
      alter table wagering.transactions drop constraint transaction_status;
      alter table wagering.transactions drop constraint opening_processed_positive;
      alter table wagering.transactions rename to openings;
      alter table wagering.openings alter column kind set default 'OPENING';
      alter table wagering.openings alter column status set default 'PROCESSED';
      alter table wagering.openings add unique(wallet_id);
      alter table wagering.openings add constraint openings_kind_check check(kind = 'OPENING');
      alter table wagering.openings add constraint openings_status_check check(status = 'PROCESSED');
      alter table wagering.openings add constraint openings_amount_check check(amount > 0);
      alter table wagering.outbox drop constraint event_type_nonempty;
      alter table wagering.outbox drop constraint event_payload_object;
      alter table wagering.outbox add constraint outbox_event_type_check check(event_type = 'WalletBalanceChanged');
      alter table wagering.outbox add constraint outbox_check check((payload->>'eventId' = event_id::text and payload->>'aggregateId' = aggregate_id::text and payload->>'eventType' = event_type and payload->>'version' = '1') is true);
      create trigger openings_immutable before update or delete or truncate on wagering.openings for each statement execute function wagering.immutable_record();
      create constraint trigger wallet_consistency after insert or update on wagering.wallets deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger journal_consistency after insert on wagering.journal deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger opening_consistency after insert on wagering.openings deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger outbox_consistency after insert on wagering.outbox deferrable initially deferred for each row execute function wagering.validate_opening();
      create view wagering.wallet_ledger as select j.id, j.wallet_id, j.transaction_id, 'OPENING'::text as kind, 'CREDIT'::text as direction,
        j.amount, j.currency, j.balance_before, j.balance_after, j.wallet_version, j.created_at from wagering.journal j;
      grant select on wagering.wallet_ledger to jungle_runtime;
    `);
  }
}
