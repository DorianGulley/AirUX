import {
  listOpenReviewsToolInputSchema,
  listOpenReviewsToolOutputSchema,
} from "@airux/shared/v1";

export interface AiruxOpenReviewsApi {
  listOpenReviews(signal: AbortSignal): Promise<unknown>;
}

export interface ListOpenReviewsWorkflowDependencies {
  readonly api: AiruxOpenReviewsApi;
}

export class ListOpenReviewsWorkflowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ListOpenReviewsWorkflowError";
  }
}

export async function listAiruxOpenReviews(
  input: unknown,
  dependencies: ListOpenReviewsWorkflowDependencies,
  signal: AbortSignal = new AbortController().signal,
) {
  const parsed = listOpenReviewsToolInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ListOpenReviewsWorkflowError("Invalid tool input");
  }

  try {
    return listOpenReviewsToolOutputSchema.parse(
      await dependencies.api.listOpenReviews(signal),
    );
  } catch (error) {
    throw new ListOpenReviewsWorkflowError(
      "The open AirUX Reviews could not be retrieved",
      { cause: error },
    );
  }
}
