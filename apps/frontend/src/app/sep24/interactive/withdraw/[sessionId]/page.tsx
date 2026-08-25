import { Sep24InteractiveForm } from '../../../../../components/sep24/Sep24InteractiveForm';

export default function Sep24WithdrawPage({
  params,
}: {
  params: { sessionId: string };
}): JSX.Element {
  return <Sep24InteractiveForm sessionId={params.sessionId} kind="withdraw" />;
}
