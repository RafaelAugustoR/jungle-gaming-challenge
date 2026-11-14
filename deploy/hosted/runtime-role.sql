-- Hosted runtime role with an operator-provided password (psql variable runtime_password).
-- Grants are owned by the migrations, exactly as in the local stack.
SELECT format('CREATE ROLE jungle_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jungle_runtime') \gexec
SELECT format('ALTER ROLE jungle_runtime PASSWORD %L', :'runtime_password') \gexec
