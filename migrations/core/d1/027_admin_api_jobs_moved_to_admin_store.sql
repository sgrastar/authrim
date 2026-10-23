-- Admin jobs are kept in the Admin database, where the scheduled runs claim them. These were
-- created here and never run; those still waiting are closed as failed, with the reason.

-- Jobs of the admin jobs API, to create again: run now, a bulk change or an import made long ago
-- would act on accounts as the administrator no longer expects, and an import's upload may already
-- be removed.
UPDATE admin_jobs
   SET status = 'failed',
       error_code = 'admin_job_store_moved',
       error_message = 'Not run: created before admin jobs moved to the Admin database. Create the job again.',
       completed_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       dead_lettered_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
 WHERE job_type IN (
         'users/import',
         'users/bulk-update',
         'reports/generate',
         'organizations/bulk-members'
       )
   AND status IN ('pending', 'processing');

-- Tenant lifecycle validations: retrying one moves it to the Admin database and runs it.
UPDATE admin_jobs
   SET status = 'failed',
       error_code = 'admin_job_store_moved',
       error_message = 'Not run: created before admin jobs moved to the Admin database. Retry the validation.',
       completed_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       dead_lettered_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
 WHERE job_type = 'tenants/lifecycle-validation'
   AND status IN ('pending', 'processing');

-- Support Ops cohort snapshots, and their cohorts: the cohort is created again.
UPDATE support_operation_cohorts
   SET snapshot_status = 'failed',
       snapshot_error = 'admin_job_store_moved'
 WHERE snapshot_status IN ('pending', 'running')
   AND snapshot_job_id IN (
         SELECT id FROM admin_jobs
          WHERE job_type = 'support-ops/cohort-snapshot'
            AND status IN ('pending', 'processing')
       );

UPDATE admin_jobs
   SET status = 'failed',
       error_code = 'admin_job_store_moved',
       error_message = 'Not run: created before admin jobs moved to the Admin database. Create the cohort again.',
       completed_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       dead_lettered_at = __AUTHRIM_NOW_EPOCH_SECONDS__,
       updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
 WHERE job_type = 'support-ops/cohort-snapshot'
   AND status IN ('pending', 'processing');
