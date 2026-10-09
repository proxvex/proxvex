# TEST-ONLY env template for the livetest postgrest overlay. Like an app's
# secrets template (e.g. heimvio's secrets.env.tpl) it is the env_file
# property default and carries a stack value. proxvex must render it on
# installation AND reconfigure (env_file is install-only, so on reconfigure
# it exists only as the default); 357-post-check-env-rendered verifies.
LIVETEST_ENV_PROBE={{ POSTGRES_PASSWORD }}
