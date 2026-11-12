// 404 Route Handler
const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Resource not found at ${req.method} ${req.originalUrl}`
  });
};

// Global Error Handler
const errorHandler = (err, req, res, next) => {
  let statusCode = err.status || err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  let message = err.message || 'Internal Server Error';

  // Handle Mongoose Duplicate Key Error (e.g. duplicate uuid)
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value entered for ${field}: "${err.keyValue[field]}". A pothole with this ${field} already exists.`;
  }

  // Handle Mongoose Validation Error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    const errors = Object.values(err.errors).map((e) => e.message);
    message = errors.join(', ');
  }

  // Handle CastError (invalid types)
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid format for field: ${err.path}`;
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      statusCode
    }
  });
};

module.exports = {
  notFoundHandler,
  errorHandler
};
