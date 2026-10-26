import { createAwsSdkAssetReader, loadAwsSamlDeployment } from './startup/aws-assets';
import { parseAwsSamlDeploymentLocation } from './startup/deployment-config';
import { createLazyAwsSamlLambdaHandler } from './startup/lazy-lambda-handler';

const reader = createAwsSdkAssetReader(process.env.AWS_REGION);
const lambda = createLazyAwsSamlLambdaHandler({
  async loadTenants() {
    const loaded = await loadAwsSamlDeployment({
      location: parseAwsSamlDeploymentLocation(process.env),
      reader,
    });
    return { tenants: [loaded.runtime], close: () => loaded.close() };
  },
});

/** API Gateway HTTP API v2 entrypoint; no migrations, imports, or Cloudflare calls. */
export const handler = lambda.handler;
