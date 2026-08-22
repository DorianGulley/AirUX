interface StreamVideoDeletionHandle {
  delete(): Promise<void>;
}

const STREAM_NOT_FOUND_MESSAGE =
  "Not Found: The requested resource or operation was not found.";

function isNotFoundError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    (error.name === "NotFoundError" &&
      "statusCode" in error &&
      error.statusCode === 404) ||
    (error.name === "Error" && error.message === STREAM_NOT_FOUND_MESSAGE)
  );
}

export async function deleteStreamVideo(
  video: StreamVideoDeletionHandle,
): Promise<void> {
  try {
    await video.delete();
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}
