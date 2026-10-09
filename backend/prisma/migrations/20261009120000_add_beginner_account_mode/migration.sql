-- Separate commit before the partial index uses the new PostgreSQL enum value.
ALTER TYPE "TradingAccountMode" ADD VALUE 'beginner';
