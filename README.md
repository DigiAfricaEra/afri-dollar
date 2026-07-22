# AfriDollar

Stellar-powered financial infrastructure for African businesses.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)

## Overview

AfriDollar is a comprehensive financial infrastructure platform built on the Stellar blockchain, designed to provide African businesses with access to digital dollars, transparent foreign exchange services, and fast cross-border payments. The platform leverages USDC on Stellar, compliant asset issuance, and interoperable payment rails to help businesses reduce currency volatility risks, access USD liquidity, and settle transactions in seconds.

## Vision

To make digital dollar access and cross-border payments seamless, transparent, and accessible for businesses across Africa.

## Mission

To build compliant and scalable financial infrastructure using Stellar that enables African businesses to transact globally with speed, reliability, and low cost.

## Key Features

- **Business Wallets**: Self-custodied Stellar wallets designed for businesses
- **Treasury Management**: Digital dollar treasury management using USDC
- **FX Conversion**: Conversion between local currencies and USDC with transparent exchange rates
- **Payroll Infrastructure**: Payroll distribution in USDC and local stable assets
- **Cross-Border Payments**: Infrastructure for supplier and international settlement payments
- **Compliance Layer**: Authorization flags, clawback functionality, KYC/AML verification

## Architecture

```
Frontend → Backend Services → Stellar Infrastructure
                         ↓
              Treasury & Compliance Layer
                         ↓
                 Banking Integrations
```

## Tech Stack

| Layer            | Technology                                     |
| ---------------- | ---------------------------------------------- |
| Frontend         | Next.js 14, React 18, TypeScript, Tailwind CSS |
| Backend          | Express.js, TypeScript, REST APIs              |
| Blockchain       | Stellar SDK, Soroban SDK, Stellar Horizon APIs |
| Database         | PostgreSQL, Redis                              |
| Containerization | Docker                                         |
| Infrastructure   | Cloud Services                                 |

## Project Structure

```
afri-dollar/
├── apps/
│   ├── backend/          # Express.js backend API
│   └── frontend/         # Next.js frontend application
├── packages/
│   ├── database/         # Shared database configurations and migrations
│   └── shared/           # Shared utilities and types
├── .github/              # GitHub workflows and configurations
└── docs/                 # Additional documentation
```

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL
- Redis
- Docker (optional, for containerization)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/0xdevmes/afri-dollar.git
cd afri-dollar
```

2. Install dependencies:

```bash
npm install
```

3. Set up environment variables:

```bash
cp .env.example .env
```

Configure the required environment variables in `.env`:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/afridollar
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SECRET_KEY=your_secret_key

# API Keys
CIRCLE_API_KEY=your_circle_api_key
REHIVE_API_KEY=your_rehive_api_key

# JWT
JWT_SECRET=your_jwt_secret
```

4. Set up the database:

```bash
npm run db:migrate
npm run db:seed
```

5. Start the development servers:

```bash
npm run dev
```

This will start both the frontend (http://localhost:3000) and backend (http://localhost:3001) servers.

## Available Scripts

- `npm run dev` - Start development servers for all apps and packages
- `npm run build` - Build all apps and packages for production
- `npm run test` - Run tests across all packages
- `npm run lint` - Run ESLint across all packages
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting
- `npm run type-check` - Run TypeScript type checking across all packages

## Development Workflow

### Working with the Monorepo

This project uses Turborepo for monorepo management. Each app and package can be developed independently:

```bash
# Run specific app
npm run dev --filter=backend
npm run dev --filter=frontend

# Build specific app
npm run build --filter=backend
npm run build --filter=frontend
```

### Code Quality

The project uses Husky for Git hooks and lint-staged for pre-commit checks:

- ESLint for linting
- Prettier for code formatting
- Commitlint for commit message conventions
- TypeScript for type checking

### Commit Convention

Follow the Conventional Commits specification:

```
feat: add new feature
fix: fix bug
docs: update documentation
style: format code
refactor: refactor code
test: add tests
chore: update dependencies
```

## API Documentation

### Backend API

The backend API runs on `http://localhost:3001` in development.

Key endpoints:

- `GET /health` - Health check endpoint
- `GET /api/v1` - API information
- `POST /api/v1/auth/login` - User authentication
- `POST /api/v1/wallet/create` - Create wallet
- `GET /api/v1/wallet/balance` - Get wallet balance
- `POST /api/v1/transactions/send` - Send transaction

For detailed API documentation, see [apps/backend/README.md](apps/backend/README.md).

### Frontend Application

The frontend application runs on `http://localhost:3000` in development.

For detailed frontend documentation, see [apps/frontend/README.md](apps/frontend/README.md).

## Stellar Integration

### Components Used

- **USDC on Stellar**: Stable digital dollar access, treasury operations, cross-border settlement
- **SEP-24**: Deposit/withdrawal interoperability, fiat on/off-ramp integrations
- **Stellar Classic Assets**: Compliant local currency asset issuance
- **Stellar Asset Contracts (SAC)**: Smart contract compatibility
- **Soroban**: Programmable financial logic and automation

### Network Configuration

- **Testnet**: Used for development and testing
- **Mainnet**: Production deployment (future)

## Security & Compliance

### Security Measures

- Encrypted API communication
- Secure wallet management
- Multi-layer authentication
- Infrastructure monitoring
- Transaction auditing

### Compliance

AfriDollar maintains compliance through:

- KYC/AML procedures
- FATF-aligned controls
- Transaction monitoring
- Asset authorization controls
- Clawback functionality where required

For detailed security information, see [SECURITY.md](SECURITY.md).

## Product Roadmap

### Phase 1 — MVP (Current)

- Wallet infrastructure
- USDC integrations
- Internal ledger synchronization
- Basic treasury dashboard
- Testnet asset issuance

### Phase 2 — Testnet Expansion

- SEP-24 integration
- Stable asset issuance
- Circle API integration
- Compliance systems
- Soroban compatibility

### Phase 3 — Mainnet Launch

- Mainnet deployment
- Business onboarding
- Payroll-as-a-Service
- Treasury automation
- Local banking integrations

## Contributing

We welcome contributions! Please see our contributing guidelines for details.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Team

### Founders

- **Eleazar Musa** - Founder
- **Ebube Ebuka Onuora** - Co-Founder
- **Jethro Adamu** - CTO / Co-Founder

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, email dev.mes.anonfedora@gmail.com or open an issue in the repository.

## Community

- **Telegram Channel**: [Telegram Channel](https://t.me/DigiAfrcaEra)
- **Community Group**: [Telegram Community](https://t.me/DigiAfrcaEra/1)

## Acknowledgments

- Stellar Development Foundation
- Circle
- The open-source community

![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/DigiAfricaEra/afri-dollar?utm_source=oss&utm_medium=github&utm_campaign=DigiAfricaEra%2Fafri-dollar&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

## Links

- [GitHub Organization Repository](https://github.com/DigiAfricaEra/afri-dollar)
- [Telegram Channel](https://t.me/DigiAfrcaEra)
- [Project Community](https://t.me/DigiAfrcaEra/1)
- [Documentation](https://prickle-kryptops-023.notion.site/AfriDollar-Documentation-370b31338d4c803ab47edb04cc3928a3)
- [Whitepaper](https://prickle-kryptops-023.notion.site/AfriDollar-Whitepaper-370b31338d4c80569f9ce2b0796f85c4)
- [Compliance Policies](https://prickle-kryptops-023.notion.site/AfriDollar-Compliance-Policies-370b31338d4c807db9e0db2e746b2c98)
