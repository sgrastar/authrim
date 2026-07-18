import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { JsonObject, JsonValue } from '../../core';
import type {
  AgentJsonSchemaValidationResult,
  AgentJsonSchemaValidatorPort,
} from '../../platform/ports';

/** Draft 2020-12 validator that is safe in edge runtimes (no eval/new Function). */
export class McpSdkJsonSchemaValidator implements AgentJsonSchemaValidatorPort {
  private readonly provider = new CfWorkerJsonSchemaValidator({
    draft: '2020-12',
    shortcircuit: false,
  });

  validate(schema: JsonObject, input: JsonValue): AgentJsonSchemaValidationResult {
    // @cfworker/json-schema annotates the schema while dereferencing it. Tool catalog snapshots
    // are intentionally frozen, so validate a private clone and never mutate the catalog contract.
    const result = this.provider.getValidator(structuredClone(schema))(input);
    return result.valid ? { valid: true } : { valid: false, errorMessage: result.errorMessage };
  }
}
