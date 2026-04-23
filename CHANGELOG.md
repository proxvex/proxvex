# Changelog

## [0.3.0](https://github.com/volkmarnissen/proxvex/compare/proxvex-v0.2.0...proxvex-v0.3.0) (2026-02-24)


### Features

* Add application_name to OCI outputs and pass it to VM creation ([1499dd2](https://github.com/volkmarnissen/proxvex/commit/1499dd24e4cec98733b46551f5e63b84439dd844))
* add enum values API and related functionality ([68e95e3](https://github.com/volkmarnissen/proxvex/commit/68e95e3ab6315a4a6f231b399ef895ebd5994c54))
* Add JSON file to track changes for replacing 'Proxvex' with 'Proxvex' ([f15c719](https://github.com/volkmarnissen/proxvex/commit/f15c7197ed0337277bb72d5308588e117eb9ef73))
* Add OCI image tag to outputs and scripts for enhanced version tracking ([54c958f](https://github.com/volkmarnissen/proxvex/commit/54c958fe7c6c13cbcfa48333a1f10507675f2ba5))
* Add template processing and validation modules ([62f54e8](https://github.com/volkmarnissen/proxvex/commit/62f54e8129e010f7b3c98740b8638b6d6a1c43dc))
* Enhance OCI container listing by decoding config text for accurate parsing ([198bae7](https://github.com/volkmarnissen/proxvex/commit/198bae7e59d5d6403045e037ba978b325ba7bed9))
* Enhance OCI image retrieval by adding application_id and oci_image to output ([8fc4a09](https://github.com/volkmarnissen/proxvex/commit/8fc4a095d0f42dd24dd5bff6438d5aa1da663721))
* First partly stable version: It creates and installs several applications successfully ([#10](https://github.com/volkmarnissen/proxvex/issues/10)) ([b290003](https://github.com/volkmarnissen/proxvex/commit/b29000353cb3dd551211a3cfebb9600af4a9ce0c))
* Implement copy-upgrade functionality for OCI containers ([896303b](https://github.com/volkmarnissen/proxvex/commit/896303b08d2bcc7786c8f7ee3910832b51962ee7))
* Implement script to find variants of "Proxvex" in the repository ([1b8795d](https://github.com/volkmarnissen/proxvex/commit/1b8795df2c3af6b751b62460973eff94a56d4a38))
* Implement script to replace 'Proxvex' variants with 'Proxvex' ([6d273bb](https://github.com/volkmarnissen/proxvex/commit/6d273bb0798e89de063d7bccaa4f18dcba8dae35))
* migrate to resource-based script and library content handling ([32c38a5](https://github.com/volkmarnissen/proxvex/commit/32c38a5418f6b3d43cd5f23690c755d3ed263714))


### Bug Fixes

* Add labels to Dockerfile of github-runner and test worker ([ceadccd](https://github.com/volkmarnissen/proxvex/commit/ceadccdd2336b7b057447a124d423e537a41ef92))
* add space in section header for better readability in application development guide ([3683701](https://github.com/volkmarnissen/proxvex/commit/368370193032486ffdc9cbd86ea59a5b8e797f5f))
* Error in uid and gid mapping ([#26](https://github.com/volkmarnissen/proxvex/issues/26)) ([c4838a0](https://github.com/volkmarnissen/proxvex/commit/c4838a0cb7ff742262dabe020061092e736d63a8))
* Fix/idmap and labels ([#27](https://github.com/volkmarnissen/proxvex/issues/27)) ([60c22ce](https://github.com/volkmarnissen/proxvex/commit/60c22cef964c66161ad393a7b87a88fd64c4ec26))
* install-proxvex.sh failed to install because of wrong library handling ([71ae62c](https://github.com/volkmarnissen/proxvex/commit/71ae62cd9b5d269b3d46b417fcda48890d66e95d))
* pnpm install works ([c489182](https://github.com/volkmarnissen/proxvex/commit/c489182b8f22a9dc278c5186c8b2e39b1192e4b2))
* Remove redundant newline and improve output formatting in installation script ([caa801e](https://github.com/volkmarnissen/proxvex/commit/caa801e2c89b0427d8cc2e25f5f5dd2ddafa49c9))
* update OWNER variable to match OCI_OWNER in install-proxvex.sh ([55f2a4d](https://github.com/volkmarnissen/proxvex/commit/55f2a4da33aff9c6c4b48b1d85fd2bee434e9f52))
* use -a flag in grep to check for existing mounts in bind-multiple-volumes-to-lxc.sh ([4a5a576](https://github.com/volkmarnissen/proxvex/commit/4a5a57640ed5e8196d827bacf47d20e17ead577f))
* Use parameter expansion for OCI_OWNER and OWNER in installation script ([4b829aa](https://github.com/volkmarnissen/proxvex/commit/4b829aa0891c41752c1692bd05fc86822b9b7d4b))


### Miscellaneous

* **main:** release proxvex 0.2.0 ([759e865](https://github.com/volkmarnissen/proxvex/commit/759e865f779d8d22e8ae988333b9685467b92c56))


### Documentation

* Use proxvex as repository owner ([204f453](https://github.com/volkmarnissen/proxvex/commit/204f453d7557a8a437c5373b28533794b6462565))


### Refactoring

* migrate tests from Jasmine/Karma to Vitest ([8785609](https://github.com/volkmarnissen/proxvex/commit/8785609bf7e0187008b41d710b2b2cdbc6bb340a))
* remove deprecated test files and helper classes ([173df46](https://github.com/volkmarnissen/proxvex/commit/173df462c44c2af53998c863819cd1d78f807886))
* streamline OCI image download and volume binding in install-proxvex.sh ([8254520](https://github.com/volkmarnissen/proxvex/commit/825452079b31503801d28471b62dc7e9bc880bfc))
* update application development guide to improve clarity and remove outdated manual JSON section ([1b7479e](https://github.com/volkmarnissen/proxvex/commit/1b7479edc73c68e595e2694b64cd80d6b4dabf04))
* update installation instructions and enhance application development guide ([af23bc7](https://github.com/volkmarnissen/proxvex/commit/af23bc7eafac4ccca6676c80948d1f5ae4f631b2))
* update template processor interfaces and improve documentation ([f813486](https://github.com/volkmarnissen/proxvex/commit/f8134863e55c278bf43ac1eccf3953f05919f180))
* update tests and script to use template variables for UID/GID mapping ([1238e9b](https://github.com/volkmarnissen/proxvex/commit/1238e9b9bd30bd2468a2c6078fbcadbac9b444d8))

## [0.2.0](https://github.com/volkmarnissen/proxvex/compare/proxvex-v0.1.22...proxvex-v0.2.0) (2026-02-23)


### Features

* Add application_name to OCI outputs and pass it to VM creation ([1499dd2](https://github.com/volkmarnissen/proxvex/commit/1499dd24e4cec98733b46551f5e63b84439dd844))
* add enum values API and related functionality ([68e95e3](https://github.com/volkmarnissen/proxvex/commit/68e95e3ab6315a4a6f231b399ef895ebd5994c54))
* Add JSON file to track changes for replacing 'Proxvex' with 'Proxvex' ([f15c719](https://github.com/volkmarnissen/proxvex/commit/f15c7197ed0337277bb72d5308588e117eb9ef73))
* Add OCI image tag to outputs and scripts for enhanced version tracking ([54c958f](https://github.com/volkmarnissen/proxvex/commit/54c958fe7c6c13cbcfa48333a1f10507675f2ba5))
* Add template processing and validation modules ([62f54e8](https://github.com/volkmarnissen/proxvex/commit/62f54e8129e010f7b3c98740b8638b6d6a1c43dc))
* Enhance OCI container listing by decoding config text for accurate parsing ([198bae7](https://github.com/volkmarnissen/proxvex/commit/198bae7e59d5d6403045e037ba978b325ba7bed9))
* Enhance OCI image retrieval by adding application_id and oci_image to output ([8fc4a09](https://github.com/volkmarnissen/proxvex/commit/8fc4a095d0f42dd24dd5bff6438d5aa1da663721))
* First partly stable version: It creates and installs several applications successfully ([#10](https://github.com/volkmarnissen/proxvex/issues/10)) ([b290003](https://github.com/volkmarnissen/proxvex/commit/b29000353cb3dd551211a3cfebb9600af4a9ce0c))
* Implement copy-upgrade functionality for OCI containers ([896303b](https://github.com/volkmarnissen/proxvex/commit/896303b08d2bcc7786c8f7ee3910832b51962ee7))
* Implement script to find variants of "Proxvex" in the repository ([1b8795d](https://github.com/volkmarnissen/proxvex/commit/1b8795df2c3af6b751b62460973eff94a56d4a38))
* Implement script to replace 'Proxvex' variants with 'Proxvex' ([6d273bb](https://github.com/volkmarnissen/proxvex/commit/6d273bb0798e89de063d7bccaa4f18dcba8dae35))
* migrate to resource-based script and library content handling ([32c38a5](https://github.com/volkmarnissen/proxvex/commit/32c38a5418f6b3d43cd5f23690c755d3ed263714))


### Bug Fixes

* add space in section header for better readability in application development guide ([3683701](https://github.com/volkmarnissen/proxvex/commit/368370193032486ffdc9cbd86ea59a5b8e797f5f))
* Remove redundant newline and improve output formatting in installation script ([caa801e](https://github.com/volkmarnissen/proxvex/commit/caa801e2c89b0427d8cc2e25f5f5dd2ddafa49c9))
* update OWNER variable to match OCI_OWNER in install-proxvex.sh ([55f2a4d](https://github.com/volkmarnissen/proxvex/commit/55f2a4da33aff9c6c4b48b1d85fd2bee434e9f52))
* use -a flag in grep to check for existing mounts in bind-multiple-volumes-to-lxc.sh ([4a5a576](https://github.com/volkmarnissen/proxvex/commit/4a5a57640ed5e8196d827bacf47d20e17ead577f))
* Use parameter expansion for OCI_OWNER and OWNER in installation script ([4b829aa](https://github.com/volkmarnissen/proxvex/commit/4b829aa0891c41752c1692bd05fc86822b9b7d4b))


### Refactoring

* migrate tests from Jasmine/Karma to Vitest ([8785609](https://github.com/volkmarnissen/proxvex/commit/8785609bf7e0187008b41d710b2b2cdbc6bb340a))
* remove deprecated test files and helper classes ([173df46](https://github.com/volkmarnissen/proxvex/commit/173df462c44c2af53998c863819cd1d78f807886))
* streamline OCI image download and volume binding in install-proxvex.sh ([8254520](https://github.com/volkmarnissen/proxvex/commit/825452079b31503801d28471b62dc7e9bc880bfc))
* update application development guide to improve clarity and remove outdated manual JSON section ([1b7479e](https://github.com/volkmarnissen/proxvex/commit/1b7479edc73c68e595e2694b64cd80d6b4dabf04))
* update installation instructions and enhance application development guide ([af23bc7](https://github.com/volkmarnissen/proxvex/commit/af23bc7eafac4ccca6676c80948d1f5ae4f631b2))
* update template processor interfaces and improve documentation ([f813486](https://github.com/volkmarnissen/proxvex/commit/f8134863e55c278bf43ac1eccf3953f05919f180))
* update tests and script to use template variables for UID/GID mapping ([1238e9b](https://github.com/volkmarnissen/proxvex/commit/1238e9b9bd30bd2468a2c6078fbcadbac9b444d8))
