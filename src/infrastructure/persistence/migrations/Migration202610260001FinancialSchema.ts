import { Migration } from '@mikro-orm/migrations';

/** Hand-written constraints are authoritative; do not replace with automatic schema sync. */
export class Migration202610260001FinancialSchema extends Migration {
  private target(): string {
    const schema = this.config.get('schema') ?? 'public';
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('INVALID_MIGRATION_SCHEMA');
    return `"${schema}"`;
  }
  override async up(): Promise<void> {
    const s = this.target();
    this.addSql(`
      create table ${s}.wallets (
        id uuid primary key, player_id uuid not null,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric not null check (scale(balance) <= 2 and balance between 0 and 999999999999999999.99),
        version integer not null check (version >= 1),
        created_at timestamptz not null, updated_at timestamptz not null,
        unique(player_id, currency), unique(id, currency)
      );
      create table ${s}.wager_transactions (
        id uuid primary key,
        provider_id text not null check (btrim(provider_id) <> ''),
        external_transaction_id text not null check (btrim(external_transaction_id) <> ''),
        idempotency_key text not null unique check (btrim(idempotency_key) <> ''),
        payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id uuid not null references ${s}.wallets(id) on delete restrict,
        player_id uuid not null, round_id text not null, game_id text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric not null check (scale(amount) <= 2 and amount between 0 and 999999999999999999.99),
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid references ${s}.wager_transactions(id) on delete restrict deferrable initially deferred,
        status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text, created_at timestamptz not null, processed_at timestamptz,
        result_snapshot jsonb,
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        unique(provider_id, external_transaction_id), unique(id, wallet_id, currency),
        check ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)),
        check (btrim(round_id) <> '' and btrim(game_id) <> ''),
        check (reference_external_transaction_id is null or
          (btrim(reference_external_transaction_id) <> '' and reference_external_transaction_id <> external_transaction_id)),
        check (case when kind in ('REFUND','ROLLBACK') then reference_external_transaction_id is not null
          when kind = 'WIN' then true else reference_external_transaction_id is null end),
        check (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null),
        check ((status = 'PROCESSED') = (processed_at is not null)),
        check ((status in ('PROCESSED','REJECTED','FAILED')) = (result_snapshot is not null)),
        check (result_snapshot is null or jsonb_typeof(result_snapshot) = 'object'),
        check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        check (failure_code is null or
          (status = 'FAILED' and failure_code = 'PERMANENT_INFRASTRUCTURE_FAILURE') or
          (status = 'REJECTED' and failure_code in ('WALLET_NOT_FOUND','PLAYER_MISMATCH','CURRENCY_MISMATCH',
            'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_MISMATCH','REFERENCE_KIND_INVALID',
            'REFERENCE_NOT_PROCESSED','REFERENCE_EXPIRED','REVERSAL_ALREADY_APPLIED'))),
        check ((status = 'PROCESSED' and reference_external_transaction_id is not null) = (reference_transaction_id is not null)),
        check (reference_transaction_id is null or reference_transaction_id <> id)
      );
      create unique index successful_reversal_once on ${s}.wager_transactions(reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
      create unique index opening_once on ${s}.wager_transactions(wallet_id)
        where kind = 'OPENING' and status = 'PROCESSED';
      create index pending_reference_due on ${s}.wager_transactions(next_reference_attempt_at, id)
        where status = 'PENDING_REFERENCE';
      create table ${s}.wallet_ledger (
        id uuid primary key, wallet_id uuid not null,
        transaction_id uuid not null, currency text not null,
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount numeric not null check (scale(amount) <= 2 and amount > 0 and amount <= 999999999999999999.99),
        balance_before numeric not null check (scale(balance_before) <= 2 and balance_before between 0 and 999999999999999999.99),
        balance_after numeric not null check (scale(balance_after) <= 2 and balance_after between 0 and 999999999999999999.99),
        wallet_version integer not null check (wallet_version >= 1),
        created_at timestamptz not null,
        unique(wallet_id, transaction_id), unique(wallet_id, wallet_version),
        foreign key (wallet_id, currency) references ${s}.wallets(id, currency) on delete restrict,
        foreign key (transaction_id, wallet_id, currency)
          references ${s}.wager_transactions(id, wallet_id, currency) on delete restrict deferrable initially deferred,
        check (balance_after = case when direction = 'CREDIT' then balance_before + amount else balance_before - amount end)
      );
      create index ledger_cursor on ${s}.wallet_ledger(wallet_id, created_at, id);
      create table ${s}.inbox_messages (
        consumer_name text not null check (btrim(consumer_name) <> ''),
        message_id text not null check (btrim(message_id) <> ''),
        payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
        received_at timestamptz not null, processed_at timestamptz,
        primary key(consumer_name, message_id)
      );
      create table ${s}.outbox_messages (
        id uuid primary key, aggregate_id uuid not null, event_type text not null,
        payload jsonb not null check (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz not null, attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz, published_at timestamptz, lease_token uuid, lease_until timestamptz,
        check ((lease_token is null) = (lease_until is null)),
        check (coalesce(payload ->> 'eventId' = id::text, false)),
        check (coalesce(payload ->> 'eventType' = event_type, false)),
        check (coalesce(payload ->> 'aggregateId' = aggregate_id::text, false)),
        check (coalesce(payload -> 'version' = '1'::jsonb, false)),
        check (coalesce(jsonb_typeof(payload -> 'data') = 'object', false)),
        check (coalesce(btrim(payload ->> 'correlationId') <> '', false)),
        check (coalesce((payload ->> 'occurredAt')::timestamptz = occurred_at, false)),
        check (event_type in ('WagerTransactionProcessed','WagerTransactionRejected',
          'WagerTransactionPendingReference','WalletBalanceChanged'))
      );
      create index outbox_due on ${s}.outbox_messages(next_attempt_at, occurred_at, id) where published_at is null;

      create function ${s}.guard_financial_write() returns trigger language plpgsql set search_path = pg_catalog as $$
      begin
        if TG_OP in ('DELETE','TRUNCATE') then raise exception 'FINANCIAL_AUDIT_IMMUTABLE' using errcode = '23514'; end if;
        if TG_TABLE_NAME = 'wallet_ledger' and TG_OP = 'UPDATE' then
          raise exception 'LEDGER_IMMUTABLE' using errcode = '23514';
        end if;
        if TG_TABLE_NAME = 'wallets' then
          if TG_OP = 'INSERT' then
            if NEW.version <> 1 then raise exception 'WALLET_INITIAL_VERSION' using errcode = '23514'; end if;
          else
            if row(NEW.id, NEW.player_id, NEW.currency, NEW.created_at) is distinct from row(OLD.id, OLD.player_id, OLD.currency, OLD.created_at) then
              raise exception 'WALLET_IDENTITY_IMMUTABLE' using errcode = '23514';
            end if;
            if (NEW.balance <> OLD.balance and NEW.version <> OLD.version + 1)
              or (NEW.balance = OLD.balance and NEW.version <> OLD.version) then
              raise exception 'WALLET_VERSION_MISMATCH' using errcode = '23514';
            end if;
          end if;
        elsif TG_TABLE_NAME = 'wager_transactions' and TG_OP = 'UPDATE' then
          if OLD.status in ('PROCESSED','REJECTED','FAILED') and NEW is distinct from OLD then
            raise exception 'TRANSACTION_TERMINAL_IMMUTABLE' using errcode = '23514';
          end if;
          if row(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
            is distinct from row(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) then
            raise exception 'TRANSACTION_IDENTITY_IMMUTABLE' using errcode = '23514';
          end if;
          if OLD.status = 'PENDING_REFERENCE' and NEW.status = 'PENDING' then
            raise exception 'INVALID_TRANSACTION_TRANSITION' using errcode = '23514';
          end if;
        elsif TG_TABLE_NAME = 'inbox_messages' and TG_OP = 'UPDATE' then
          if row(NEW.consumer_name,NEW.message_id,NEW.payload_hash,NEW.received_at)
            is distinct from row(OLD.consumer_name,OLD.message_id,OLD.payload_hash,OLD.received_at)
            or (OLD.processed_at is not null and NEW.processed_at is distinct from OLD.processed_at) then
            raise exception 'INBOX_IDENTITY_IMMUTABLE' using errcode = '23514';
          end if;
        elsif TG_TABLE_NAME = 'outbox_messages' and TG_OP = 'UPDATE' then
          if row(NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
            is distinct from row(OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) then
            raise exception 'OUTBOX_EVENT_IMMUTABLE' using errcode = '23514';
          end if;
        end if;
        return NEW;
      end $$;
      create function ${s}.lock_financial_wallet() returns trigger language plpgsql set search_path = pg_catalog as $$
      begin
        perform 1 from ${s}.wallets where id = NEW.wallet_id for update;
        return NEW;
      end $$;
      create function ${s}.check_financial_consistency() returns trigger language plpgsql set search_path = pg_catalog as $$
      declare wid uuid; w record; total numeric; changes bigint;
      begin
        if TG_TABLE_NAME = 'wallets' then wid := NEW.id; else wid := NEW.wallet_id; end if;
        select * into w from ${s}.wallets where id = wid for update;
        if not found then return null; end if;
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)
          into total from ${s}.wallet_ledger where wallet_id = wid;
        if total <> w.balance then raise exception 'WALLET_LEDGER_DIVERGENCE' using errcode = '23514'; end if;
        select count(*) into changes from ${s}.wallet_ledger l join ${s}.wager_transactions t on t.id = l.transaction_id
          where l.wallet_id = wid and t.kind <> 'OPENING';
        if w.version <> 1 + changes then raise exception 'WALLET_LEDGER_VERSION' using errcode = '23514'; end if;
        if exists (
          select 1 from ${s}.wager_transactions t left join ${s}.wallet_ledger l on l.transaction_id = t.id and l.wallet_id = t.wallet_id
          left join ${s}.wager_transactions r on r.id = t.reference_transaction_id
          where t.wallet_id = wid and (
            ((t.status = 'PROCESSED' and t.kind <> 'LOSS') <> (l.id is not null))
            or (t.status = 'PROCESSED' and (t.player_id <> w.player_id or t.currency <> w.currency))
            or (l.id is not null and (l.amount <> t.amount or l.currency <> t.currency
              or (t.kind = 'OPENING' and l.wallet_version <> 1)
              or (t.kind <> 'OPENING' and l.wallet_version < 2) or l.wallet_version > w.version
              or l.direction <> case when t.kind = 'BET' then 'DEBIT'
                when t.kind = 'ROLLBACK' then case when r.kind = 'BET' then 'CREDIT' else 'DEBIT' end else 'CREDIT' end))
            or (t.status = 'PROCESSED' and t.reference_transaction_id is not null and (
              r.id is null or r.status <> 'PROCESSED' or r.provider_id <> t.provider_id
              or r.external_transaction_id <> t.reference_external_transaction_id
              or r.wallet_id <> t.wallet_id or r.player_id <> t.player_id or r.currency <> t.currency or r.round_id <> t.round_id
              or (t.kind in ('REFUND','WIN') and r.kind <> 'BET')
              or (t.kind = 'ROLLBACK' and r.kind not in ('BET','WIN','REFUND'))
              or (t.kind in ('REFUND','ROLLBACK') and r.amount <> t.amount)))
          )
        ) then raise exception 'TRANSACTION_LEDGER_MISMATCH' using errcode = '23514'; end if;
        if exists (
          select 1 from (
            select l.*, sum(case direction when 'CREDIT' then amount else -amount end)
              over (order by wallet_version rows between unbounded preceding and current row) as calculated
            from ${s}.wallet_ledger l where wallet_id = wid
          ) chain where balance_after <> calculated
            or balance_before <> calculated - case direction when 'CREDIT' then amount else -amount end
        ) then raise exception 'LEDGER_CHAIN_MISMATCH' using errcode = '23514'; end if;
        return null;
      end $$;
    `);
    for (const table of ['wallets','wager_transactions','wallet_ledger','inbox_messages','outbox_messages']) {
      this.addSql(`create trigger guard_write before insert or update or delete on ${s}.${table}
        for each row execute function ${s}.guard_financial_write();
        create trigger guard_truncate before truncate on ${s}.${table}
        for each statement execute function ${s}.guard_financial_write();
        revoke all on ${s}.${table} from public;`);
    }
    for (const table of ['wager_transactions','wallet_ledger']) {
      this.addSql(`create trigger lock_wallet before insert or update on ${s}.${table}
        for each row execute function ${s}.lock_financial_wallet();`);
    }
    for (const table of ['wallets','wager_transactions','wallet_ledger']) {
      this.addSql(`create constraint trigger financial_consistency after insert or update on ${s}.${table}
        deferrable initially deferred for each row execute function ${s}.check_financial_consistency();`);
    }
  }
  override async down(): Promise<void> {
    const s = this.target();
    for (const table of ['outbox_messages','inbox_messages','wallet_ledger','wager_transactions','wallets']) {
      this.addSql(`drop table ${s}.${table};`);
    }
    for (const name of ['check_financial_consistency','lock_financial_wallet','guard_financial_write']) {
      this.addSql(`drop function ${s}.${name}();`);
    }
  }
}
