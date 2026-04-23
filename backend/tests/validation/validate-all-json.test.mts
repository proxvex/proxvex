import { describe, it, expect } from "vitest";
import { validateAllJson } from "@src/validateAllJson.mjs";

/**
 * This test validates all JSON files in the project (templates, applications, frameworks, addons).
 * It ensures that when all unit tests pass, all JSON configurations are also valid.
 *
 * This is equivalent to running: node proxvex.mjs validate
 */
describe("validateAllJson", () => {
  it("should validate all templates, applications, frameworks and addons without errors", async () => {
    // validateAllJson throws ValidationError if validation fails
    // If no error is thrown, all validations passed
    await expect(validateAllJson()).resolves.toBeUndefined();
  }, 120000); // 2 minute timeout - validation can be slow due to template processing
});
