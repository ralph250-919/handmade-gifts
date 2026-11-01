/** An error whose message is safe to show to the customer, with an HTTP status. */
export class UserFacingError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}
