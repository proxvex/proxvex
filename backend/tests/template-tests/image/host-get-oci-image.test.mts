import { describe, it, inject, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

describe.skipIf(!hostReachable)("Template: host-get-oci-image", () => {
  const config = loadTemplateTestConfig();
  const helper = new TemplateTestHelper(config);

  it("should download postgres:latest and resolve version via digest matching", async () => {
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
      console.log("STDOUT:", result.stdout.slice(0, 500));
      console.log("EXIT:", result.exitCode);
    }
    // Debug: check interpreter detection
    const { interpreter } = helper.prepareScript({
      templatePath: "shared/templates/image/011-host-get-oci-image.json",
      inputs: { oci_image: "postgres:latest", storage: "local" },
    });
    console.log("Detected interpreter:", interpreter);
    expect(result.success).toBe(true);
    expect(result.outputs.template_path).toBeTruthy();
    expect(result.outputs.ostype).toBeTruthy();
    expect(result.outputs.arch).toBe("amd64");
    // postgres has no version labels — requires digest matching against remote tags
    // Should resolve to a version like "17.5" (not "latest")
    expect(result.outputs.oci_image_tag).toMatch(/^\d+\.\d+/);
    console.log(`postgres:latest resolved to: ${result.outputs.oci_image_tag}`);
  }, 300000);

  it("should download postgrest/postgrest:latest and resolve version via digest matching", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/image/011-host-get-oci-image.json",
      inputs: {
        oci_image: "postgrest/postgrest:latest",
        storage: "local",
      },
      timeout: 180000,
    });

    expect(result.success).toBe(true);
    expect(result.outputs.template_path).toBeTruthy();
    // PostgREST has no version labels — requires digest matching against remote tags
    // Should resolve to a version like "v12.2.8" (not "latest")
    expect(result.outputs.oci_image_tag).not.toBe("latest");
    console.log(`postgrest:latest resolved to: ${result.outputs.oci_image_tag}`);
  }, 300000);
});
