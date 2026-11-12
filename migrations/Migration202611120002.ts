import { Migration } from '@mikro-orm/migrations';

export class Migration202611120002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      create domain wagering.money_amount as numeric check (
        value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        and scale(value) <= 2 and value >= 0 and value <= 9999999999999999.99
      );
      create table wagering.accounts (
        id uuid primary key, currency text not null check (currency ~ '^[A-Z]{3}$'),
        kind text not null check (kind in ('PLAYER', 'OPENING', 'GAMING')),
        unique(id, currency)
      );
      insert into wagering.accounts(id, currency, kind) values (gen_random_uuid(), 'BRL', 'OPENING'), (gen_random_uuid(), 'BRL', 'GAMING');
      create unique index counterpart_currency on wagering.accounts(currency, kind) where kind <> 'PLAYER';
      create table wagering.wallets (
        id uuid primary key, player_id text not null check (length(trim(player_id)) between 1 and 128),
        currency text not null check (currency ~ '^[A-Z]{3}$'), balance wagering.money_amount not null,
        version integer not null check (version >= 1), account_id uuid not null unique,
        unique(player_id, currency), unique(id, currency),
        foreign key(account_id, currency) references wagering.accounts(id, currency)
      );
      create table wagering.transactions (
        id uuid primary key, wallet_id uuid not null, currency text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        status text not null default 'PROCESSED' check (status = 'PROCESSED'),
        amount wagering.money_amount not null,
        check (kind <> 'OPENING' or amount > 0),
        created_at timestamptz not null default clock_timestamp(),
        unique(id, wallet_id, currency, amount), unique(id, wallet_id),
        foreign key(wallet_id, currency) references wagering.wallets(id, currency)
      );
      create unique index one_opening_per_wallet on wagering.transactions(wallet_id) where kind = 'OPENING';
      -- One row is both sides of a journal: a partial pair is unrepresentable.
      create table wagering.journal (
        id uuid primary key, transaction_id uuid not null unique, wallet_id uuid not null,
        currency text not null, amount wagering.money_amount not null check (amount > 0),
        debit_account_id uuid not null, credit_account_id uuid not null,
        balance_before wagering.money_amount not null, balance_after wagering.money_amount not null,
        wallet_version integer not null check (wallet_version >= 1),
        created_at timestamptz not null default clock_timestamp(),
        check (debit_account_id <> credit_account_id),
        unique(wallet_id, wallet_version),
        foreign key(debit_account_id, currency) references wagering.accounts(id, currency),
        foreign key(credit_account_id, currency) references wagering.accounts(id, currency),
        foreign key(transaction_id, wallet_id, currency, amount) references wagering.transactions(id, wallet_id, currency, amount)
      );
      create table wagering.outbox (
        event_id uuid primary key, aggregate_id uuid not null references wagering.wallets(id),
        transaction_id uuid not null,
        foreign key(transaction_id, aggregate_id) references wagering.transactions(id, wallet_id),
        sequence integer not null check (sequence > 0),
        event_type text not null, payload jsonb not null,
        occurred_at timestamptz not null default clock_timestamp(),
        unique(aggregate_id, sequence), unique(transaction_id, event_type),
        check (length(event_type) > 0),
        check (jsonb_typeof(payload) = 'object')
      );
      create function wagering.immutable_record() returns trigger language plpgsql as $$
      begin raise exception 'IMMUTABLE_FINANCIAL_RECORD' using errcode = '23514'; end $$;
      create trigger journal_immutable before update or delete or truncate on wagering.journal for each statement execute function wagering.immutable_record();
      create trigger transactions_immutable before update or delete or truncate on wagering.transactions for each statement execute function wagering.immutable_record();
      create trigger accounts_immutable before update or delete or truncate on wagering.accounts for each statement execute function wagering.immutable_record();
      create trigger outbox_immutable before update or delete or truncate on wagering.outbox for each statement execute function wagering.immutable_record();
      create function wagering.wallet_identity() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.account_id) is distinct from (old.id, old.player_id, old.currency, old.account_id) then
          raise exception 'IMMUTABLE_WALLET_IDENTITY' using errcode = '23514';
        end if;
        return new;
      end $$;
      create trigger wallet_identity before update on wagering.wallets for each row execute function wagering.wallet_identity();
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
      revoke all on schema wagering from public;
      grant usage on schema wagering to jungle_runtime;
      grant select on all tables in schema wagering to jungle_runtime;
      grant insert on wagering.wallets, wagering.accounts, wagering.transactions, wagering.journal, wagering.outbox to jungle_runtime;
      grant update(balance, version) on wagering.wallets to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`drop view wagering.wallet_ledger;
      drop table wagering.outbox, wagering.journal, wagering.transactions, wagering.wallets, wagering.accounts;
      drop function wagering.check_wallet_chain(), wagering.check_journal_chain(), wagering.check_transaction_journal(), wagering.check_balance_event();
      drop function wagering.assert_wallet_chain(uuid), wagering.assert_journal_chain(uuid), wagering.assert_transaction_journal(uuid);
      drop function wagering.wallet_identity(), wagering.immutable_record();
      drop domain wagering.money_amount;`);
  }
}
