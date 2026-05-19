export class SAMLMetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SAMLMetadataValidationError';
  }
}
