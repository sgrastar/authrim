-- Organisation types use the core vocabulary (distributor, enterprise, department) that token
-- claims, consent context, JIT organisation creation and the column's own default already use.
-- The Admin API wrote personal, team and partner; those rows are renamed to the core type of the
-- same meaning. A personal organisation has no department or distributor meaning, so it takes the
-- column default, enterprise.
UPDATE organizations SET org_type = 'department' WHERE org_type = 'team';
UPDATE organizations SET org_type = 'distributor' WHERE org_type = 'partner';
UPDATE organizations SET org_type = 'enterprise' WHERE org_type = 'personal';
