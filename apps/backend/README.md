# AfriDollar Backend

Express.js backend API for AfriDollar - a Stellar-powered financial infrastructure platform for African businesses.

## Overview

The backend provides RESTful APIs for wallet management, treasury operations, FX conversions, payroll processing, and cross-border payments. It integrates with Stellar blockchain, Circle APIs, and banking infrastructure to deliver compliant and scalable financial services.

## Tech Stack

- **Framework**: Express.js with TypeScript
- **Blockchain**: Stellar SDK, Soroban SDK, Stellar Horizon APIs
- **Database**: PostgreSQL with Prisma ORM
- **Caching**: Redis
- **Authentication**: JWT with bcrypt
- **Security**: Helmet, CORS, rate limiting
- **Validation**: Zod
- **Testing**: Jest, Supertest
- **API Documentation**: Swagger/OpenAPI

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     API Gateway Layer                        │
│              (Express.js + Middleware)                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Service Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Wallet   │  │ Treasury │  │   FX     │  │ Payroll  │   │
│  │ Service  │  │ Service  │  │ Service  │  │ Service  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Data Layer                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │PostgreSQL│  │  Redis   │  │ Stellar  │  │ External │   │
│  │ Database │  │  Cache   │  │ Horizon  │  │  APIs    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
backend/
├── src/
│   ├── controllers/        # Request handlers
│   ├── services/          # Business logic
│   ├── models/            # Database models
│   ├── middleware/        # Express middleware
│   ├── routes/            # API route definitions
│   ├── utils/             # Utility functions
│   ├── config/            # Configuration files
│   ├── types/             # TypeScript type definitions
│   └── index.ts           # Application entry point
├── tests/                 # Test files
├── .env.example           # Environment variables template
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL >= 14
- Redis >= 6
- Stellar testnet account

### Installation

1. Install dependencies:

```bash
npm install
```

2. Set up environment variables:

```bash
cp .env.example .env
```

Configure the required environment variables in `.env`:

```env
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/afridollar
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SECRET_KEY=your_secret_key
STELLAR_PUBLIC_KEY=your_public_key

# Circle API
CIRCLE_API_KEY=your_circle_api_key
CIRCLE_API_URL=https://api.circle.com

# Rehive
REHIVE_API_KEY=your_rehive_api_key
REHIVE_API_URL=https://api.rehive.com

# JWT
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d

# KYC/AML
KYC_PROVIDER_URL=your_kyc_provider_url
KYC_API_KEY=your_kyc_api_key

# Banking
BANKING_API_URL=your_banking_api_url
BANKING_API_KEY=your_banking_api_key

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Security
IP_REPUTATION_SERVICE_URL=https://example.com/ip-reputation
```

3. Set up the database:

```bash
# Run migrations
npm run db:migrate

# Seed database (optional)
npm run db:seed
```

4. Start the development server:

```bash
npm run dev
```

The API will be available at `http://localhost:3001`

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint issues automatically
- `npm run type-check` - Run TypeScript type checking
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report
- `npm run db:migrate` - Run database migrations
- `npm run db:seed` - Seed database with initial data
- `npm run db:reset` - Reset database (drop, migrate, seed)

## API Documentation

### Base URL

- Development: `http://localhost:3001`
- Production: `https://api.afridollar.com`

### Authentication

Most endpoints require authentication via JWT token in the Authorization header:

```
Authorization: Bearer <jwt_token>
```

### Core Endpoints

#### Health & Info

- `GET /health` - Health check endpoint
- `GET /api/v1` - API information and version

#### Authentication

- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/logout` - User logout
- `POST /api/v1/auth/refresh` - Refresh JWT token
- `GET /api/v1/auth/me` - Get current user info

#### Security (Admin Only)

- `GET /api/v1/security/metrics` - View blocked and flagged IP metrics (Admin only)
- `GET /api/v1/security/blocked-ips` - List currently blocked IPs (Admin only)
- `GET /api/v1/security/flagged-ips` - List flagged IPs and failed attempts (Admin only)

#### Wallet Management

- `POST /api/v1/wallet/create` - Create new Stellar wallet
- `GET /api/v1/wallet/:id` - Get wallet details
- `GET /api/v1/wallet/:id/balance` - Get wallet balance
- `GET /api/v1/wallet/:id/transactions` - Get wallet transaction history
- `POST /api/v1/wallet/:id/fund` - Fund wallet with USDC
- `POST /api/v1/wallet/:id/withdraw` - Withdraw from wallet

#### Treasury Management

- `GET /api/v1/treasury/balance` - Get treasury balance
- `GET /api/v1/treasury/positions` - Get treasury positions
- `POST /api/v1/treasury/rebalance` - Rebalance treasury
- `GET /api/v1/treasury/history` - Get treasury operations history

#### FX Conversion

- `GET /api/v1/fx/rates` - Get current FX rates
- `POST /api/v1/fx/quote` - Get FX quote
- `POST /api/v1/fx/convert` - Execute FX conversion
- `GET /api/v1/fx/history` - Get conversion history

#### Payroll

- `POST /api/v1/payroll/create` - Create payroll batch
- `GET /api/v1/payroll/:id` - Get payroll details
- `POST /api/v1/payroll/:id/approve` - Approve payroll
- `POST /api/v1/payroll/:id/process` - Process payroll
- `GET /api/v1/payroll/history` - Get payroll history

#### Cross-Border Payments

- `POST /api/v1/payments/send` - Send cross-border payment
- `GET /api/v1/payments/:id` - Get payment details
- `GET /api/v1/payments/:id/status` - Get payment status
- `POST /api/v1/payments/:id/cancel` - Cancel payment

#### Compliance

- `POST /api/v1/compliance/kyc` - Submit KYC verification
- `GET /api/v1/compliance/kyc/:id` - Get KYC status
- `POST /api/v1/compliance/aml-check` - Run AML check
- `GET /api/v1/compliance/transactions` - Get flagged transactions

### API Response Format

Success response:

```json
{
  "success": true,
  "data": { ... },
  "message": "Operation successful"
}
```

Error response:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message",
    "details": { ... }
  }
}
```

## Stellar Integration

### Wallet Operations

The backend integrates with Stellar for:

- **Wallet Creation**: Generate Stellar keypairs using Stellar SDK
- **Balance Queries**: Fetch account balances from Horizon API
- **Transaction Submission**: Submit signed transactions to Stellar network
- **Asset Management**: Issue and manage custom assets
- **USDC Operations**: Handle USDC deposits and withdrawals

### Soroban Integration

Future support for:

- Smart contract deployment
- Contract interaction
- Automated financial logic
- Treasury automation

### SEP-24 Integration

Deposit and withdrawal flows:

- **Deposit**: Fiat → USDC via SEP-24 compliant anchor
- **Withdrawal**: USDC → Fiat via SEP-24 compliant anchor

## Database Schema

### Core Tables

- `users` - User accounts and authentication
- `wallets` - Stellar wallet addresses and metadata
- `transactions` - Transaction records and status
- `treasury` - Treasury positions and operations
- `fx_rates` - Foreign exchange rates
- `payroll_batches` - Payroll batch records
- `payroll_items` - Individual payroll items
- `compliance_records` - KYC/AML compliance data
- `audit_logs` - System audit trail

## Security

### Authentication

- JWT-based authentication
- bcrypt password hashing
- Token expiration and refresh
- Multi-factor authentication (MFA) support

### Authorization

- Role-based access control (RBAC)
- Permission-based endpoint access
- Admin, user, and auditor roles

### Rate Limiting

- Per-endpoint rate limiting
- IP-based throttling
- Configurable limits via environment variables
- Progressive lockouts for repeated login failures
- Stricter auth limits for flagged IPs
- Optional third-party IP reputation integration

### Data Protection

- Encrypted sensitive data at rest
- TLS/SSL for data in transit
- Secure key management
- Audit logging for sensitive operations

## Error Handling

### Error Codes

- `AUTH_001` - Invalid credentials
- `AUTH_002` - Token expired
- `WALLET_001` - Wallet not found
- `WALLET_002` - Insufficient balance
- `TXN_001` - Transaction failed
- `TXN_002` - Invalid transaction
- `FX_001` - Invalid FX rate
- `COMPLIANCE_001` - KYC verification failed
- `SERVER_001` - Internal server error

### Logging

- Structured logging with Winston
- Log levels: error, warn, info, debug
- Log aggregation and monitoring
- Sensitive data redaction

## Testing

### Unit Tests

```bash
npm run test
```

### Integration Tests

```bash
npm run test:integration
```

### Test Coverage

```bash
npm run test:coverage
```

## Deployment

### Docker

Build and run with Docker:

```bash
docker build -t afridollar-backend .
docker run -p 3001:3001 --env-file .env afridollar-backend
```

### Environment Variables

Ensure all required environment variables are set in production:

- Database connection strings
- API keys for external services
- Stellar network configuration
- JWT secrets
- CORS origins

### Monitoring

- Application performance monitoring (APM)
- Error tracking (Sentry)
- Log aggregation (ELK stack)
- Health check endpoints

## Development Guidelines

### Code Style

- Follow ESLint rules
- Use Prettier for formatting
- Write TypeScript with strict mode
- Add JSDoc comments for public functions

### Git Workflow

- Create feature branches from `main`
- Use conventional commit messages
- Ensure tests pass before pushing
- Request code review for PRs

### Testing

- Write unit tests for business logic
- Write integration tests for API endpoints
- Aim for >80% code coverage
- Mock external dependencies

## Troubleshooting

### Common Issues

**Database connection failed**

- Check DATABASE_URL in .env
- Ensure PostgreSQL is running
- Verify database credentials

**Stellar transaction failed**

- Check STELLAR_NETWORK configuration
- Verify account has sufficient XLM for fees
- Check Horizon API status

**Redis connection failed**

- Check REDIS_URL in .env
- Ensure Redis is running
- Verify Redis credentials

## Support & Community

For backend-specific support and community discussion:

- Email: dev.mes.anonfedora@gmail.com
- GitHub Issues: [afri-dollar/issues](https://github.com/DigiAfricaEra/afri-dollar/issues)
- Telegram Channel: [Telegram Channel](https://t.me/DigiAfrcaEra)
- Telegram Community: [Telegram Community Group](https://t.me/DigiAfrcaEra/1)

## License

MIT License - see root LICENSE file for details
