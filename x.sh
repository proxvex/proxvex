# E2E_INSTANCE=github-action ./e2e/step0-*.sh
# E2E_INSTANCE=github-action ./e2e/step1-*.sh
E2E_INSTANCE=github-action ./e2e/step2-*.sh # --update-only
cat https-addon-params.json
node backend/dist/cli/oci-lxc-cli.mjs remote \
  --server http://ubuntupve:2080 --ve pve-e2e-nested.local \
  postgres installation https-addon-params.json
 ssh root@ubuntupve "qm snapshot 9001 databaseinstalled"
cd backend && npm run build && cd -
node backend/dist/cli/oci-lxc-cli.mjs remote \
 --server http://ubuntupve:2080 --ve pve-e2e-nested.local --verbose \
 zitadel installation https-addon-params.json

