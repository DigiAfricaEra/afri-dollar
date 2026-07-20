import type { Options } from 'swagger-jsdoc';

const swaggerOptions: Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'AfriDollar API',
      version: '0.1.0',
      description:
        'Stellar-powered financial infrastructure API for African businesses. Provides wallet management, treasury operations, FX conversions, payroll processing, and cross-border payments.',
      contact: {
        name: 'AfriDollar Team',
        email: 'team@afridollar.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
      {
        url: 'https://api.afridollar.com',
        description: 'Production server',
      },
    ],
    tags: [
      { name: 'Health', description: 'Health check and API info endpoints' },
      { name: 'Auth', description: 'User authentication and registration' },
      { name: 'FX', description: 'Foreign exchange rates and conversions' },
      { name: 'Payments', description: 'Cross-border payment operations' },
      { name: 'Payroll', description: 'Payroll batch management' },
      { name: 'Stellar', description: 'Stellar blockchain operations' },
      { name: 'Treasury', description: 'Platform treasury management (admin only)' },
      { name: 'Audit', description: 'Audit log queries (admin only)' },
      { name: 'Wallet', description: 'Wallet creation and management' },
      { name: 'Admin FX', description: 'Admin exchange rate management (admin only)' },
      {
        name: 'Admin Dashboard',
        description: 'Admin user, transaction, compliance, and system management (admin only)',
      },
      { name: 'Security', description: 'IP security metrics and blocking (admin only)' },
      { name: 'Jobs', description: 'Background job monitoring (admin only)' },
      { name: 'Reports', description: 'Report generation and templates' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
            message: { type: 'string' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          description: 'Returns the health status of the backend API',
          operationId: 'healthCheck',
          responses: {
            '200': {
              description: 'API is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      message: {
                        type: 'string',
                        example: 'AfriDollar Backend API is running',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1': {
        get: {
          tags: ['Health'],
          summary: 'API information',
          description: 'Returns API name, version, and description',
          operationId: 'getApiInfo',
          responses: {
            '200': {
              description: 'API info',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'AfriDollar API' },
                      version: { type: 'string', example: '0.1.0' },
                      description: {
                        type: 'string',
                        example: 'Stellar-powered financial infrastructure API',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ─── Auth ───────────────────────────────────────────────────────
      '/api/v1/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Register a new user',
          description: 'Creates a new user account with email and password',
          operationId: 'registerUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'user@example.com' },
                    password: { type: 'string', minLength: 8, example: 'securePassword123' },
                    firstName: { type: 'string', example: 'John' },
                    lastName: { type: 'string', example: 'Doe' },
                    phoneNumber: { type: 'string', example: '+1234567890' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'User registered successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              user: { type: 'object' },
                              tokens: { type: 'object' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '409': { description: 'User already exists' },
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'User login',
          description: 'Authenticates a user and returns access and refresh tokens',
          operationId: 'loginUser',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'user@example.com' },
                    password: { type: 'string', minLength: 8, example: 'securePassword123' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Login successful',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              user: { type: 'object' },
                              tokens: { type: 'object' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Invalid credentials' },
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'User logout',
          description: 'Invalidates the refresh token and logs the user out',
          operationId: 'logoutUser',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refreshToken'],
                  properties: {
                    refreshToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Logout successful' },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/auth/refresh': {
        post: {
          tags: ['Auth'],
          summary: 'Refresh access token',
          description: 'Generates a new access token using a valid refresh token',
          operationId: 'refreshToken',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refreshToken'],
                  properties: {
                    refreshToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Token refreshed successfully',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              accessToken: { type: 'string' },
                              refreshToken: { type: 'string' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Invalid refresh token' },
          },
        },
      },
      '/api/v1/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current user',
          description: 'Returns the authenticated user profile',
          operationId: 'getCurrentUser',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'User profile',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },

      // ─── FX ─────────────────────────────────────────────────────────
      '/api/v1/fx/rates': {
        get: {
          tags: ['FX'],
          summary: 'Get current FX rates',
          description: 'Returns current foreign exchange rates',
          operationId: 'getFxRates',
          parameters: [
            {
              name: 'fromAsset',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by source asset code',
              example: 'USDC',
            },
            {
              name: 'toAsset',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by target asset code',
              example: 'NGN',
            },
          ],
          responses: {
            '200': {
              description: 'FX rates retrieved',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/fx/quote': {
        post: {
          tags: ['FX'],
          summary: 'Get FX quote',
          description: 'Returns a quote for a foreign exchange conversion',
          operationId: 'createFxQuote',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fromAsset', 'toAsset', 'amount'],
                  properties: {
                    fromAsset: { type: 'string', minLength: 1, example: 'USDC' },
                    toAsset: { type: 'string', minLength: 1, example: 'NGN' },
                    amount: { type: 'string', minLength: 1, example: '1000' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'FX quote returned',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
          },
        },
      },
      '/api/v1/fx/convert': {
        post: {
          tags: ['FX'],
          summary: 'Execute FX conversion',
          description: 'Executes a foreign exchange conversion using a previously created quote',
          operationId: 'convertFx',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['quoteId', 'walletId'],
                  properties: {
                    quoteId: { type: 'string', minLength: 1, example: 'quote_abc123' },
                    walletId: { type: 'string', minLength: 1, example: 'wallet_abc123' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Conversion executed',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '400': { description: 'Invalid or expired quote' },
          },
        },
      },
      '/api/v1/fx/history': {
        get: {
          tags: ['FX'],
          summary: 'Get conversion history',
          description: 'Returns the authenticated user FX conversion history',
          operationId: 'getFxHistory',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'walletId',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by wallet ID',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', maximum: 100 },
              description: 'Max results',
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Pagination cursor',
            },
            {
              name: 'fromDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'Start date (ISO 8601)',
            },
            {
              name: 'toDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'End date (ISO 8601)',
            },
          ],
          responses: {
            '200': {
              description: 'Conversion history',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },

      // ─── Payments ───────────────────────────────────────────────────
      '/api/v1/payments': {
        post: {
          tags: ['Payments'],
          summary: 'Create cross-border payment',
          description: 'Creates a new cross-border payment',
          operationId: 'createPayment',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'sourceWalletId',
                    'destinationAddress',
                    'amount',
                    'assetCode',
                    'purpose',
                  ],
                  properties: {
                    sourceWalletId: { type: 'string', minLength: 1, example: 'wallet_abc123' },
                    destinationAddress: {
                      type: 'string',
                      minLength: 56,
                      maxLength: 56,
                      example: 'GBXM25OYZ5YF7ZK6QNW7S3E4B5A2C6D3F2G4H5J3K5L7M7N2P4Q6R7S5',
                    },
                    amount: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', example: '100.00' },
                    assetCode: { type: 'string', minLength: 1, maxLength: 12, example: 'USDC' },
                    assetIssuer: { type: 'string', minLength: 56, maxLength: 56 },
                    memo: { type: 'string', maxLength: 28, example: 'Invoice payment' },
                    purpose: { type: 'string', minLength: 1, example: 'Business payment' },
                    beneficiaryInfo: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', example: 'John Doe' },
                        country: {
                          type: 'string',
                          example: 'NG',
                          description: '2 or 3 letter ISO country code',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Payment created',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/payments/{id}/process': {
        post: {
          tags: ['Payments'],
          summary: 'Process a payment',
          description: 'Processes a previously created payment',
          operationId: 'processPayment',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Payment ID',
            },
          ],
          responses: {
            '200': {
              description: 'Payment processed',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Payment not found' },
          },
        },
      },
      '/api/v1/payments/{id}/status': {
        get: {
          tags: ['Payments'],
          summary: 'Get payment status',
          description: 'Returns the current status of a payment',
          operationId: 'getPaymentStatus',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Payment ID',
            },
          ],
          responses: {
            '200': {
              description: 'Payment status',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Payment not found' },
          },
        },
      },
      '/api/v1/payments/history': {
        get: {
          tags: ['Payments'],
          summary: 'Get payment history',
          description: 'Returns the authenticated user payment history',
          operationId: 'getPaymentHistory',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'walletId',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by wallet ID',
            },
          ],
          responses: {
            '200': {
              description: 'Payment history',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/payments/{id}/cancel': {
        post: {
          tags: ['Payments'],
          summary: 'Cancel a payment',
          description: 'Cancels a pending payment',
          operationId: 'cancelPayment',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Payment ID',
            },
          ],
          responses: {
            '200': {
              description: 'Payment cancelled',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Payment not found' },
          },
        },
      },

      // ─── Payroll ────────────────────────────────────────────────────
      '/api/v1/payroll/batches': {
        post: {
          tags: ['Payroll'],
          summary: 'Create payroll batch',
          description: 'Creates a new payroll batch',
          operationId: 'createPayrollBatch',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'walletId'],
                  properties: {
                    name: { type: 'string', minLength: 1, example: 'January 2024 Payroll' },
                    description: { type: 'string', example: 'Monthly payroll batch' },
                    walletId: { type: 'string', minLength: 1, example: 'wallet_abc123' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Batch created',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
          },
        },
        get: {
          tags: ['Payroll'],
          summary: 'List payroll batches',
          description: 'Returns all payroll batches for the authenticated user',
          operationId: 'listPayrollBatches',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'List of payroll batches',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/payroll/batches/{id}': {
        get: {
          tags: ['Payroll'],
          summary: 'Get payroll batch details',
          description: 'Returns details of a specific payroll batch',
          operationId: 'getPayrollBatch',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Batch ID',
            },
          ],
          responses: {
            '200': {
              description: 'Batch details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Batch not found' },
          },
        },
      },
      '/api/v1/payroll/batches/{id}/items': {
        post: {
          tags: ['Payroll'],
          summary: 'Add item to payroll batch',
          description: 'Adds a new item to an existing payroll batch',
          operationId: 'addPayrollBatchItem',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Batch ID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['recipientAddress', 'amount', 'assetCode'],
                  properties: {
                    recipientAddress: {
                      type: 'string',
                      example: 'GBXM25OYZ5YF7ZK6QNW7S3E4B5A2C6D3F2G4H5J3K5L7M7N2P4Q6R7S5',
                    },
                    amount: { type: 'string', minLength: 1, example: '500.00' },
                    assetCode: { type: 'string', minLength: 1, example: 'USDC' },
                    assetIssuer: { type: 'string' },
                    memo: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Item added',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Batch not found' },
          },
        },
      },
      '/api/v1/payroll/batches/{id}/approve': {
        post: {
          tags: ['Payroll'],
          summary: 'Approve payroll batch',
          description: 'Approves a payroll batch for processing',
          operationId: 'approvePayrollBatch',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Batch ID',
            },
          ],
          responses: {
            '200': {
              description: 'Batch approved',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Batch not found' },
          },
        },
      },
      '/api/v1/payroll/batches/{id}/process': {
        post: {
          tags: ['Payroll'],
          summary: 'Process payroll batch',
          description: 'Processes an approved payroll batch and executes payments',
          operationId: 'processPayrollBatch',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Batch ID',
            },
          ],
          responses: {
            '200': {
              description: 'Batch processed',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Batch not found' },
          },
        },
      },
      '/api/v1/payroll/history': {
        get: {
          tags: ['Payroll'],
          summary: 'Get payroll history',
          description: 'Returns the payroll processing history',
          operationId: 'getPayrollHistory',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Payroll history',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },

      // ─── Stellar ────────────────────────────────────────────────────
      '/api/v1/stellar/balances/{publicKey}': {
        get: {
          tags: ['Stellar'],
          summary: 'Get Stellar account balances',
          description: 'Fetches Stellar account balances for the given public key',
          operationId: 'getStellarBalances',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'publicKey',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 56, maxLength: 56 },
              description: 'Stellar public key',
            },
          ],
          responses: {
            '200': {
              description: 'Account balances',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/stellar/transactions/{publicKey}': {
        get: {
          tags: ['Stellar'],
          summary: 'Get Stellar transaction history',
          description: 'Fetches paginated transaction history for a Stellar account',
          operationId: 'getStellarTransactions',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'publicKey',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 56, maxLength: 56 },
              description: 'Stellar public key',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
              description: 'Number of transactions to return',
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Pagination cursor',
            },
          ],
          responses: {
            '200': {
              description: 'Transaction history',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/stellar/fund/{publicKey}': {
        post: {
          tags: ['Stellar'],
          summary: 'Fund Stellar testnet account',
          description: 'Funds a Stellar testnet account via Friendbot (testnet only)',
          operationId: 'fundStellarAccount',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'publicKey',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 56, maxLength: 56 },
              description: 'Stellar public key to fund',
            },
          ],
          responses: {
            '200': {
              description: 'Account funded',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },

      // ─── Treasury (admin only) ──────────────────────────────────────
      '/api/v1/treasury/balance': {
        get: {
          tags: ['Treasury'],
          summary: 'Get treasury balance',
          description: 'Returns the platform treasury balance (admin only)',
          operationId: 'getTreasuryBalance',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Treasury balance',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/treasury/positions': {
        get: {
          tags: ['Treasury'],
          summary: 'Get treasury positions',
          description: 'Returns current treasury positions (admin only)',
          operationId: 'getTreasuryPositions',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Treasury positions',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/treasury/rebalance': {
        post: {
          tags: ['Treasury'],
          summary: 'Rebalance treasury',
          description: 'Triggers a treasury rebalancing operation (admin only)',
          operationId: 'rebalanceTreasury',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['targets'],
                  properties: {
                    targets: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 50,
                      items: {
                        type: 'object',
                        required: ['assetCode', 'targetAllocation'],
                        properties: {
                          assetCode: { type: 'string', minLength: 1, example: 'USDC' },
                          assetIssuer: { type: 'string' },
                          targetAllocation: {
                            type: 'number',
                            minimum: 0,
                            maximum: 100,
                            example: 50,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Rebalance initiated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/treasury/history': {
        get: {
          tags: ['Treasury'],
          summary: 'Get treasury history',
          description: 'Returns treasury operations history (admin only)',
          operationId: 'getTreasuryHistory',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'type',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['deposit', 'withdrawal', 'rebalance', 'transfer'] },
              description: 'Filter by operation type',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', maximum: 200 },
              description: 'Max results',
            },
          ],
          responses: {
            '200': {
              description: 'Treasury history',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },

      // ─── Audit (admin only) ─────────────────────────────────────────
      '/api/v1/audit/logs': {
        get: {
          tags: ['Audit'],
          summary: 'Query audit logs',
          description: 'Returns audit logs (admin only)',
          operationId: 'queryAuditLogs',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'userId',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by user ID',
            },
            {
              name: 'action',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by action (partial match)',
            },
            {
              name: 'resource',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by resource (partial match)',
            },
            {
              name: 'success',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['true', 'false'] },
              description: 'Filter by success status',
            },
            {
              name: 'startDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'Start date (ISO 8601)',
            },
            {
              name: 'endDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'End date (ISO 8601)',
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
              description: 'Page number',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
              description: 'Results per page',
            },
          ],
          responses: {
            '200': {
              description: 'Audit logs',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: {
                            type: 'object',
                            properties: {
                              total: { type: 'integer' },
                              page: { type: 'integer' },
                              limit: { type: 'integer' },
                              totalPages: { type: 'integer' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },

      // ─── Wallet ─────────────────────────────────────────────────────
      '/api/v1/wallet/create': {
        post: {
          tags: ['Wallet'],
          summary: 'Create Stellar wallet',
          description: 'Creates a new Stellar wallet for the authenticated user',
          operationId: 'createWallet',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['walletType'],
                  properties: {
                    walletType: {
                      type: 'string',
                      enum: ['business', 'treasury', 'payroll'],
                      example: 'business',
                    },
                    network: {
                      type: 'string',
                      enum: ['testnet', 'mainnet'],
                      default: 'testnet',
                      example: 'testnet',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Wallet created',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
          },
        },
      },

      // ─── Admin FX (admin only) ──────────────────────────────────────
      '/api/v1/admin/fx/rates': {
        post: {
          tags: ['Admin FX'],
          summary: 'Upsert exchange rate',
          description: 'Creates or updates an exchange rate (admin only)',
          operationId: 'upsertFxRate',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fromAsset', 'toAsset', 'rate'],
                  properties: {
                    fromAsset: { type: 'string', minLength: 1, example: 'USDC' },
                    toAsset: { type: 'string', minLength: 1, example: 'NGN' },
                    rate: { type: 'string', minLength: 1, example: '1500.00' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Rate created or updated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/fx/rates/{id}': {
        delete: {
          tags: ['Admin FX'],
          summary: 'Deactivate exchange rate',
          description: 'Soft-deletes an exchange rate by setting it inactive (admin only)',
          operationId: 'deactivateFxRate',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Rate ID',
            },
          ],
          responses: {
            '200': {
              description: 'Rate deactivated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              message: { type: 'string', example: 'Exchange rate deactivated' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Rate not found' },
          },
        },
      },

      // ─── Admin Dashboard (admin only) ───────────────────────────────
      '/api/v1/admin/users': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'List users',
          description: 'Returns a paginated list of users (admin only)',
          operationId: 'listUsers',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['active', 'suspended', 'banned'] },
            },
            {
              name: 'role',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['USER', 'BUSINESS', 'ADMIN', 'AUDITOR'] },
            },
            {
              name: 'email',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Filter by email',
            },
          ],
          responses: {
            '200': {
              description: 'List of users',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/users/{id}': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get user details',
          description: 'Returns details for a specific user (admin only)',
          operationId: 'getUser',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'User ID',
            },
          ],
          responses: {
            '200': {
              description: 'User details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'User not found' },
          },
        },
      },
      '/api/v1/admin/users/{id}/status': {
        put: {
          tags: ['Admin Dashboard'],
          summary: 'Update user status',
          description: 'Changes a user account status (admin only)',
          operationId: 'updateUserStatus',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'User ID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: { type: 'string', enum: ['active', 'suspended', 'banned'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'User status updated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'User not found' },
          },
        },
      },
      '/api/v1/admin/users/{id}/activity': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get user activity',
          description: 'Returns activity log for a specific user (admin only)',
          operationId: 'getUserActivity',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'User ID',
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'User activity',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'User not found' },
          },
        },
      },
      '/api/v1/admin/transactions': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'List transactions',
          description: 'Returns a paginated list of all transactions (admin only)',
          operationId: 'listAdminTransactions',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'userId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'assetCode', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'isFlagged',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['true', 'false'] },
            },
            {
              name: 'startDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'endDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description: 'List of transactions',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/transactions/alerts': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get transaction alerts',
          description: 'Returns flagged transaction alerts (admin only)',
          operationId: 'getTransactionAlerts',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'Transaction alerts',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/transactions/{id}': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get transaction details',
          description: 'Returns details for a specific transaction (admin only)',
          operationId: 'getAdminTransaction',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Transaction ID',
            },
          ],
          responses: {
            '200': {
              description: 'Transaction details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Transaction not found' },
          },
        },
      },
      '/api/v1/admin/transactions/{id}/flag': {
        post: {
          tags: ['Admin Dashboard'],
          summary: 'Flag a transaction',
          description: 'Flags a transaction for review with a reason (admin only)',
          operationId: 'flagTransaction',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Transaction ID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reason'],
                  properties: {
                    reason: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 1000,
                      example: 'Suspicious activity detected',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Transaction flagged',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Transaction not found' },
          },
        },
      },
      '/api/v1/admin/compliance/alerts': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'List compliance alerts',
          description: 'Returns a paginated list of compliance alerts (admin only)',
          operationId: 'listComplianceAlerts',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['open', 'resolved', 'dismissed'] },
            },
            { name: 'severity', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'userId', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Compliance alerts',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/compliance/alerts/{id}': {
        put: {
          tags: ['Admin Dashboard'],
          summary: 'Resolve compliance alert',
          description: 'Updates the status of a compliance alert (admin only)',
          operationId: 'resolveComplianceAlert',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Alert ID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['resolved', 'dismissed'] },
                    resolutionNote: { type: 'string', maxLength: 2000 },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Alert updated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Alert not found' },
          },
        },
      },
      '/api/v1/admin/compliance/reports': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get compliance reports',
          description: 'Returns compliance report summary (admin only)',
          operationId: 'getComplianceReports',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Compliance reports',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/health': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'System health',
          description: 'Returns system health status (admin only)',
          operationId: 'getSystemHealth',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'System health',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/metrics': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Performance metrics',
          description: 'Returns platform performance metrics (admin only)',
          operationId: 'getPerformanceMetrics',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Performance metrics',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/logs': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'System logs',
          description: 'Returns system log entries (admin only)',
          operationId: 'getSystemLogs',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            { name: 'userId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'action', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'resource', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'success',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['true', 'false'] },
            },
            {
              name: 'startDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'endDate',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description: 'System logs',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/config': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Get platform config',
          description: 'Returns platform configuration (admin only)',
          operationId: 'getConfig',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Platform config',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
        put: {
          tags: ['Admin Dashboard'],
          summary: 'Update platform config',
          description: 'Updates platform configuration keys (admin only)',
          operationId: 'updateConfig',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['configs'],
                  properties: {
                    configs: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 50,
                      items: {
                        type: 'object',
                        required: ['key', 'value'],
                        properties: {
                          key: { type: 'string', minLength: 1, maxLength: 100 },
                          value: {},
                          description: { type: 'string', maxLength: 500 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Config updated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/admin/config/audit': {
        get: {
          tags: ['Admin Dashboard'],
          summary: 'Config audit trail',
          description: 'Returns the configuration change audit trail (admin only)',
          operationId: 'getConfigAudit',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'Config audit entries',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },

      // ─── Security (admin only) ──────────────────────────────────────
      '/api/v1/security/metrics': {
        get: {
          tags: ['Security'],
          summary: 'Security metrics',
          description: 'Returns blocked and flagged IP metrics (admin only)',
          operationId: 'getSecurityMetrics',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Security metrics',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/security/blocked-ips': {
        get: {
          tags: ['Security'],
          summary: 'List blocked IPs',
          description: 'Returns currently blocked IP addresses (admin only)',
          operationId: 'getBlockedIps',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Blocked IPs',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/security/flagged-ips': {
        get: {
          tags: ['Security'],
          summary: 'List flagged IPs',
          description: 'Returns IPs with failed login attempts (admin only)',
          operationId: 'getFlaggedIps',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Flagged IPs',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },

      // ─── Jobs (admin only) ──────────────────────────────────────────
      '/api/v1/jobs': {
        get: {
          tags: ['Jobs'],
          summary: 'List jobs',
          description: 'Returns queue status, job definitions, and recent executions (admin only)',
          operationId: 'listJobs',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200 },
              description: 'Max executions to return',
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Pagination cursor',
            },
          ],
          responses: {
            '200': {
              description: 'Job queue info',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/jobs/{id}': {
        get: {
          tags: ['Jobs'],
          summary: 'Get job execution details',
          description: 'Returns details for a specific job execution (admin only)',
          operationId: 'getJob',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Job execution ID',
            },
          ],
          responses: {
            '200': {
              description: 'Job details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Job not found' },
          },
        },
      },

      // ─── Reports ────────────────────────────────────────────────────
      '/api/v1/reports': {
        post: {
          tags: ['Reports'],
          summary: 'Generate report',
          description:
            'Creates a new report generation request. Some report types require admin role.',
          operationId: 'generateReport',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reportType', 'format'],
                  properties: {
                    reportType: {
                      type: 'string',
                      enum: [
                        'transaction-history',
                        'compliance-report',
                        'financial-statement',
                        'payroll-report',
                        'treasury-report',
                        'audit-log',
                      ],
                    },
                    format: { type: 'string', enum: ['csv', 'pdf', 'xlsx'] },
                    targetUserId: {
                      type: 'string',
                      description: 'Admin only: generate report for another user',
                    },
                    parameters: {
                      type: 'object',
                      properties: {
                        startDate: { type: 'string', format: 'date' },
                        endDate: { type: 'string', format: 'date' },
                        assetCode: { type: 'string' },
                        status: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Report creation accepted',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin role required for this report type' },
          },
        },
        get: {
          tags: ['Reports'],
          summary: 'List reports',
          description: 'Returns paginated list of the authenticated user reports',
          operationId: 'listReports',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, default: 1 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 10 },
            },
          ],
          responses: {
            '200': {
              description: 'List of reports',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: {
                          data: { type: 'array', items: { type: 'object' } },
                          pagination: { type: 'object' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
          },
        },
      },
      '/api/v1/reports/{id}': {
        get: {
          tags: ['Reports'],
          summary: 'Get report details',
          description: 'Returns details and status for a specific report',
          operationId: 'getReport',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Report ID',
            },
          ],
          responses: {
            '200': {
              description: 'Report details',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Report not found' },
          },
        },
      },
      '/api/v1/reports/{id}/download': {
        get: {
          tags: ['Reports'],
          summary: 'Download report',
          description: 'Downloads the generated report file',
          operationId: 'downloadReport',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Report ID',
            },
          ],
          responses: {
            '200': {
              description: 'Report file download',
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '404': { description: 'Report not found or not ready' },
          },
        },
      },
      '/api/v1/reports/templates': {
        get: {
          tags: ['Reports'],
          summary: 'List report templates',
          description: 'Returns all report templates (admin only)',
          operationId: 'listReportTemplates',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Report templates',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        type: 'object',
                        properties: { data: { type: 'array', items: { type: 'object' } } },
                      },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
        post: {
          tags: ['Reports'],
          summary: 'Create report template',
          description: 'Creates a new report template (admin only)',
          operationId: 'createReportTemplate',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'reportType', 'format'],
                  properties: {
                    name: { type: 'string', minLength: 1, example: 'Monthly transaction report' },
                    reportType: {
                      type: 'string',
                      enum: [
                        'transaction-history',
                        'compliance-report',
                        'financial-statement',
                        'payroll-report',
                        'treasury-report',
                        'audit-log',
                      ],
                    },
                    format: { type: 'string', enum: ['csv', 'pdf', 'xlsx'] },
                    query: { type: 'string', description: 'Optional SQL-like query string' },
                    schedule: {
                      type: 'string',
                      description: 'Optional cron expression (5 fields)',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Template created',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
          },
        },
      },
      '/api/v1/reports/templates/{templateId}': {
        get: {
          tags: ['Reports'],
          summary: 'Get report template',
          description: 'Returns a specific report template (admin only)',
          operationId: 'getReportTemplate',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'templateId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Template ID',
            },
          ],
          responses: {
            '200': {
              description: 'Report template',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Template not found' },
          },
        },
        put: {
          tags: ['Reports'],
          summary: 'Update report template',
          description: 'Updates an existing report template (admin only)',
          operationId: 'updateReportTemplate',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'templateId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Template ID',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', minLength: 1 },
                    reportType: {
                      type: 'string',
                      enum: [
                        'transaction-history',
                        'compliance-report',
                        'financial-statement',
                        'payroll-report',
                        'treasury-report',
                        'audit-log',
                      ],
                    },
                    format: { type: 'string', enum: ['csv', 'pdf', 'xlsx'] },
                    query: { type: 'string' },
                    schedule: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Template updated',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { type: 'object', properties: { data: { type: 'object' } } },
                    ],
                  },
                },
              },
            },
            '400': { description: 'Validation error' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Template not found' },
          },
        },
        delete: {
          tags: ['Reports'],
          summary: 'Delete report template',
          description: 'Deletes a report template (admin only)',
          operationId: 'deleteReportTemplate',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'templateId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Template ID',
            },
          ],
          responses: {
            '200': { description: 'Template deleted' },
            '401': { description: 'Unauthorized' },
            '403': { description: 'Admin privileges required' },
            '404': { description: 'Template not found' },
          },
        },
      },
    },
  },
  apis: [],
};

export default swaggerOptions;
