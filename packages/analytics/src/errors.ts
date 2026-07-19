export class AnalyticsValidationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'AnalyticsValidationError'
  }
}
