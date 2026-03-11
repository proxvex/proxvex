import express from "express";
import {
  ApiUri,
  IFrameworkNamesResponse,
  IFrameworkParametersResponse,
  IPostFrameworkCreateApplicationBody,
  IPostFrameworkCreateApplicationResponse,
  IPostFrameworkFromImageBody,
  IPostFrameworkFromImageResponse,
  IOciImageAnnotations,
  IPostPreviewUnresolvedParametersBody,
  IUnresolvedParametersResponse,
  TaskType,
} from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { FrameworkLoader } from "../frameworkloader.mjs";
import { FrameworkFromImage } from "../framework-from-image.mjs";
import { VEConfigurationError } from "../backend-types.mjs";
import { sendErrorResponse, asyncHandler } from "./webapp-error-utils.mjs";

type ReturnResponse = <T>(
  res: express.Response,
  payload: T,
  statusCode?: number,
) => void;

export function registerFrameworkRoutes(
  app: express.Application,
  storageContext: ContextManager,
  returnResponse: ReturnResponse,
): void {
  const pm = PersistenceManager.getInstance();

  app.get(ApiUri.FrameworkNames, (_req, res) => {
    try {
      const frameworkNames: Array<{ id: string; name: string }> = [];
      const allFrameworks = pm.getFrameworkService().getAllFrameworkNames();

      for (const [frameworkId] of allFrameworks) {
        try {
          const framework = pm
            .getFrameworkService()
            .readFramework(frameworkId, {
              error: new VEConfigurationError("", frameworkId),
            });
          frameworkNames.push({
            id: frameworkId,
            name: framework.name || frameworkId,
          });
        } catch {
          // Skip invalid frameworks
        }
      }

      returnResponse<IFrameworkNamesResponse>(res, {
        frameworks: frameworkNames,
      });
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });

  app.get(
    ApiUri.FrameworkParameters,
    asyncHandler(async (req, res) => {
      const frameworkId = String(req.params.frameworkId);
      if (!frameworkId) {
        return res.status(400).json({ error: "Missing frameworkId" });
      }

      const veContext = storageContext.getCurrentVEContext();
      if (!veContext) {
        return res.status(404).json({
          error: "No VE context available. Please configure SSH first.",
        });
      }

      const frameworkLoader = new FrameworkLoader(
        {
          schemaPath: storageContext
            .getJsonPath()
            .replace(/\/json$/, "/schemas"),
          jsonPath: storageContext.getJsonPath(),
          localPath: storageContext.getLocalPath(),
        },
        storageContext,
        pm.getPersistence(),
      );

      const parameters = await frameworkLoader.getParameters(
        frameworkId,
        "installation",
        veContext,
      );

      returnResponse<IFrameworkParametersResponse>(res, {
        parameters,
      });
    }),
  );

  app.post(
    ApiUri.FrameworkCreateApplication,
    express.json(),
    asyncHandler(async (req, res) => {
      const body = req.body as IPostFrameworkCreateApplicationBody;

      if (!body.frameworkId) {
        return res.status(400).json({ error: "Missing frameworkId" });
      }
      if (!body.applicationId) {
        return res.status(400).json({ error: "Missing applicationId" });
      }
      if (!body.name) {
        return res.status(400).json({ error: "Missing name" });
      }
      if (!body.description) {
        return res.status(400).json({ error: "Missing description" });
      }

      const frameworkLoader = new FrameworkLoader(
        {
          schemaPath: pm.getPathes().schemaPath,
          jsonPath: pm.getPathes().jsonPath,
          localPath: pm.getPathes().localPath,
        },
        storageContext,
        pm.getPersistence(),
      );

      const applicationId =
        await frameworkLoader.createApplicationFromFramework(body);

      returnResponse<IPostFrameworkCreateApplicationResponse>(res, {
        success: true,
        applicationId: applicationId,
      });
    }),
  );

  app.post(
    "/api/framework-from-image",
    express.json(),
    asyncHandler(async (req, res) => {
      const body = req.body as IPostFrameworkFromImageBody;

      if (!body.image) {
        return res.status(400).json({ error: "Missing image" });
      }

      const tag = body.tag || "latest";
      const veContext = storageContext.getCurrentVEContext();

      if (!veContext) {
        return res.status(400).json({
          error:
            "No VE context configured. Please configure SSH connection first.",
        });
      }

      let annotations: IOciImageAnnotations;
      try {
        annotations = await FrameworkFromImage.getAnnotationsFromImage(
          veContext,
          body.image,
          tag,
        );
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (
          errorMessage.includes("not found") ||
          errorMessage.includes("Image")
        ) {
          return res.status(404).json({
            error: `Image ${body.image}:${tag} not found`,
          });
        }
        throw err;
      }

      const defaults =
        FrameworkFromImage.buildApplicationDefaultsFromAnnotations(
          body.image,
          annotations,
        );

      returnResponse<IPostFrameworkFromImageResponse>(res, {
        annotations,
        defaults,
      });
    }),
  );

  // Preview unresolved parameters for a framework-based application
  app.post(
    ApiUri.PreviewUnresolvedParameters,
    express.json(),
    asyncHandler(async (req, res) => {
      const veContextKey = String(req.params.veContext);
      const ctx = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return res
          .status(404)
          .json({ success: false, error: "VE context not found" });
      }

      const body = req.body as IPostPreviewUnresolvedParametersBody;

      if (!body.frameworkId) {
        return res.status(400).json({ error: "Missing frameworkId" });
      }
      if (!body.name) {
        return res.status(400).json({ error: "Missing name" });
      }

      const frameworkLoader = new FrameworkLoader(
        {
          schemaPath: pm.getPathes().schemaPath,
          jsonPath: pm.getPathes().jsonPath,
          localPath: pm.getPathes().localPath,
        },
        storageContext,
        pm.getPersistence(),
      );

      const result =
        await frameworkLoader.getPreviewUnresolvedParameters(
          body,
          "installation" as TaskType,
          ctx,
        );

      // Include available addons in the response
      const addonService = pm.getAddonService();
      const addons = addonService.getAllAddonsWithParameters();

      returnResponse<IUnresolvedParametersResponse>(res, {
        unresolvedParameters: result.unresolvedParameters,
        frameworkProperties: result.frameworkProperties,
        addons,
      });
    }),
  );
}
