-- The application role is seo_app. The table owner is seo_audit_owner.
-- Those roles are created by crawlseo/docker/postgres/init/01-roles.sh.
-- seo_app is not a member of seo_audit_owner and is not a superuser.

ALTER TABLE audit_log OWNER TO seo_audit_owner;

REVOKE ALL ON TABLE audit_log FROM PUBLIC;
REVOKE ALL ON TABLE audit_log FROM seo_app;
GRANT SELECT, INSERT ON TABLE audit_log TO seo_app;

REVOKE ALL ON SEQUENCE audit_log_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE audit_log_id_seq FROM seo_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO seo_app;
