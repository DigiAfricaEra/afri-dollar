/**
 * Home component renders the landing page for AfriDollar.
 * It provides an overview of the platform's core features.
 */
const COMMUNITY_URL = 'https://t.me/DigiAfrcaEra/1';

export default function Home(): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm">
        <h1 className="text-4xl font-bold mb-4">AfriDollar</h1>
        <p className="text-xl mb-8">
          Stellar-powered financial infrastructure for African businesses
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-6 border rounded-lg">
            <h2 className="text-2xl font-semibold mb-2">Digital Dollars</h2>
            <p>Access USDC on Stellar for stable digital dollar operations</p>
          </div>
          <div className="p-6 border rounded-lg">
            <h2 className="text-2xl font-semibold mb-2">Fast Payments</h2>
            <p>Near-instant cross-border transactions at low cost</p>
          </div>
          <div className="p-6 border rounded-lg">
            <h2 className="text-2xl font-semibold mb-2">Treasury Management</h2>
            <p>Transparent and compliant digital dollar treasury operations</p>
          </div>
        </div>
        <div className="mt-10 rounded-lg border bg-white p-4 text-center">
          <p className="text-sm text-gray-600 mb-2">Community</p>
          <a
            href={COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 font-medium hover:underline"
          >
            https://t.me/DigiAfrcaEra/1
          </a>
        </div>
      </div>
    </main>
  );
}
