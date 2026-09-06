-- HOPIN Production Migration 0018: Remove redundant payroll adjustment trigger.
--
-- 0008 already attached enforce_payroll_adjustment_state() through
-- trg_payroll_adjustments_parent_state. 0017 introduced a second attachment
-- while validating that protection. Keep the original trigger as the single
-- enforcement point before advancing migrations to production.

drop trigger if exists trg_payroll_adjustments_state on public.payroll_adjustments;
