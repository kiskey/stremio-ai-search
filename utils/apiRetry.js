const logger = require("./logger");

/**
 * Executes an API call with retry logic and exponential backoff
 *
 * @param {Function} apiCallFn - Async function that makes the API call
 * @param {Object} options - Configuration options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} options.initialDelay - Initial delay in ms before first retry (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms between retries (default: 10000)
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: all non-4xx errors)
 * @param {string} options.operationName - Name of operation for logging (default: "API call")
 * @returns {Promise<any>} - Result of the API call
 */
async function withRetry(apiCallFn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    shouldRetry = (error) => {
      // By default, retry on network errors and 5xx responses
      // Don't retry on 4xx errors (client errors)
      return !error.status || error.status >= 500;
    },
    operationName = "API call",
  } = options;

  let lastError;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      // Attempt the API call
      return await apiCallFn();
    } catch (error) {
      lastError = error;
      attempt++;

      // Check if we should retry
      if (attempt > maxRetries || !shouldRetry(error)) {
        logger.error(`${operationName} failed after ${attempt} attempts`, {
          error: error.message || error,
          status: error.status,
          operationName,
        });
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        maxDelay,
        initialDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random() / 2)
      );

      logger.warn(
        `${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(
          delay
        )}ms`,
        {
          error: error.message || error,
          status: error.status,
          attempt,
          nextRetryDelay: Math.round(delay),
        }
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached due to the throw in the catch block
  throw lastError;
}

module.exports = {
  withRetry,
};
