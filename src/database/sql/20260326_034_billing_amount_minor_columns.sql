ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS amount_minor INTEGER;

UPDATE subscriptions s
SET amount_minor = CASE
  WHEN s.billing_cycle = 'yearly' THEN p.yearly_price
  ELSE p.monthly_price
END
FROM plans p
WHERE s.plan_id = p.id
  AND s.amount_minor IS NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_minor INTEGER;

UPDATE payments
SET amount_minor = amount
WHERE amount_minor IS NULL;
