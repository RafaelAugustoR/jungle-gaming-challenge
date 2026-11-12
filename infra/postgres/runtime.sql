-- Public credentials exclusively for the local demonstration. Run as migration administrator.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jungle_runtime') THEN
    CREATE ROLE jungle_runtime LOGIN PASSWORD 'runtime-demo-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
