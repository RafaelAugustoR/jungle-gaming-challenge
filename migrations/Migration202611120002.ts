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
      create table wagering.openings (
        id uuid primary key, wallet_id uuid not null unique, currency text not null,
        kind text not null default 'OPENING' check (kind = 'OPENING'),
        status text not null default 'PROCESSED' check (status = 'PROCESSED'),
        amount wagering.money_amount not null check (amount > 0),
        created_at timestamptz not null default clock_timestamp(),
        unique(id, wallet_id, currency, amount), unique(id, wallet_id),
        foreign key(wallet_id, currency) references wagering.wallets(id, currency)
      );
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
        foreign key(transaction_id, wallet_id, currency, amount) references wagering.openings(id, wallet_id, currency, amount)
      );
      create table wagering.outbox (
        event_id uuid primary key, aggregate_id uuid not null references wagering.wallets(id),
        transaction_id uuid not null,
        foreign key(transaction_id, aggregate_id) references wagering.openings(id, wallet_id),
        sequence integer not null check (sequence > 0),
        event_type text not null, payload jsonb not null,
        occurred_at timestamptz not null default clock_timestamp(),
        unique(aggregate_id, sequence), unique(transaction_id, event_type),
        check (event_type = 'WalletBalanceChanged'),
        check ((payload->>'eventId' = event_id::text and payload->>'aggregateId' = aggregate_id::text
          and payload->>'eventType' = event_type and payload->>'version' = '1') is true)
      );
      create function wagering.immutable_record() returns trigger language plpgsql as $$
      begin raise exception 'IMMUTABLE_FINANCIAL_RECORD' using errcode = '23514'; end $$;
      create trigger journal_immutable before update or delete or truncate on wagering.journal for each statement execute function wagering.immutable_record();
      create trigger openings_immutable before update or delete or truncate on wagering.openings for each statement execute function wagering.immutable_record();
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
      create function wagering.validate_opening() returns trigger language plpgsql as $$
      declare w wagering.wallets; j wagering.journal; target uuid;
      begin
        target := (to_jsonb(new)->>case when tg_table_name = 'wallets' then 'id' when tg_table_name = 'outbox' then 'aggregate_id' else 'wallet_id' end)::uuid;
        select * into strict w from wagering.wallets where id = target;
        select * into j from wagering.journal where wallet_id = target order by wallet_version desc limit 1;
        if w.version <> 1 then raise exception 'INVALID_OPENING_VERSION' using errcode = '23514'; end if;
        if j.id is null then
          if w.balance <> 0 or exists(select from wagering.openings where wallet_id = target) then
            raise exception 'OPENING_JOURNAL_REQUIRED' using errcode = '23514';
          end if;
        elsif j.wallet_version <> 1 or j.balance_before <> 0 or j.balance_after <> j.amount
          or w.balance <> j.balance_after or j.credit_account_id <> w.account_id
          or not exists(select from wagering.accounts where id = w.account_id and kind = 'PLAYER')
          or not exists(select from wagering.accounts where id = j.debit_account_id and kind = 'OPENING')
          or not exists(select from wagering.outbox where transaction_id = j.transaction_id and aggregate_id = target
            and event_type = 'WalletBalanceChanged' and payload->'data'->'balanceAfter'->>'amount' = to_char(w.balance, 'FM9999999999999990.00')
            and payload->'data'->'balanceAfter'->>'currency' = w.currency
            and payload->'data'->>'transactionId' = j.transaction_id::text
            and payload->'data'->>'walletId' = w.id::text
            and payload->'data'->>'direction' = 'CREDIT'
            and payload->'data'->>'walletVersion' = '1') then
          raise exception 'INCONSISTENT_OPENING' using errcode = '23514';
        end if;
        if not exists(select from wagering.accounts where id = w.account_id and kind = 'PLAYER') then
          raise exception 'PLAYER_ACCOUNT_REQUIRED' using errcode = '23514';
        end if;
        return null;
      end $$;
      create constraint trigger wallet_consistency after insert or update on wagering.wallets deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger journal_consistency after insert on wagering.journal deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger opening_consistency after insert on wagering.openings deferrable initially deferred for each row execute function wagering.validate_opening();
      create constraint trigger outbox_consistency after insert on wagering.outbox deferrable initially deferred for each row execute function wagering.validate_opening();
      create view wagering.wallet_ledger as
        select j.id, j.wallet_id, j.transaction_id, 'OPENING'::text as kind, 'CREDIT'::text as direction,
          j.amount, j.currency, j.balance_before, j.balance_after, j.wallet_version, j.created_at
        from wagering.journal j;
      revoke all on schema wagering from public;
      grant usage on schema wagering to jungle_runtime;
      grant select on all tables in schema wagering to jungle_runtime;
      grant insert on wagering.wallets, wagering.accounts, wagering.openings, wagering.journal, wagering.outbox to jungle_runtime;
      grant update(balance, version) on wagering.wallets to jungle_runtime;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`drop view wagering.wallet_ledger;
      drop table wagering.outbox, wagering.journal, wagering.openings, wagering.wallets, wagering.accounts;
      drop function wagering.validate_opening(), wagering.wallet_identity(), wagering.immutable_record();
      drop domain wagering.money_amount;`);
  }
}
