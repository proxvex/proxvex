import { describe, it, inject, beforeAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

describe.skipIf(!hostReachable)("Template: host-get-oci-image", () => {
  const config = loadTemplateTestConfig();
  const helper = new TemplateTestHelper(config);

  // Pre-populate test cache — no skopeo calls will be made
  beforeAll(async () => {
    await helper.setupOciVersionCache({
      "postgres:latest": "17.5",
      "postgrest/postgrest:latest": "14.7",
    });
  }, 10000);

  it("should download postgres:latest and resolve version from cache", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/image/011-host-get-oci-image.json",
      inputs: {
        oci_image: "postgres:latest",
        storage: "local",
      },
      timeout: 300000,
    });

    if (!result.success) {
      console.log("STDERR:", result.stderr);
      console.log("EXIT:", result.exitCode);
    }
    expect(result.success).toBe(true);
    expect(result.outputs.template_path).toBeTruthy();
    expect(result.outputs.ostype).toBeTruthy();
    expect(result.outputs.arch).toBe("amd64");
    // Version comes from test cache — deterministic
    expect(result.outputs.oci_image_tag).toBe("17.5");
  }, 300000);

  it("should download postgrest/postgrest:latest and resolve version from cache", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/image/011-host-get-oci-image.json",
      inputs: {
        oci_image: "postgrest/postgrest:latest",
        storage: "local",
      },
      timeout: 300000,
    });

    expect(result.success).toBe(true);
    expect(result.outputs.template_path).toBeTruthy();
    // Version comes from test cache — deterministic
    expect(result.outputs.oci_image_tag).toBe("14.7");
  }, 300000);
});
