interface StreamVideoDeletionHandle {
  delete(): Promise<void>;
}

function isNotFoundError(error: unknown) {
  return (
    error instanceof Error &&
    error.name === "NotFoundError" &&
    "statusCode" in error &&
    error.statusCode === 404
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
