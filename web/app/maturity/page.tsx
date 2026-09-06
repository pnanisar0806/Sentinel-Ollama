import { NotYetBuild, PageHead, PendingButton } from '../../lib/ui';

export default function MaturityPage() {
  return (
    <>
      <PageHead
        title="Maturity calendar"
        sub="Every dated instrument and what happens the day it redeems."
      />
      <NotYetBuild
        task="Task 1"
        why="Sammaan, your one dated instrument, redeems on 26-Sep-2026 — about three weeks out. Its interest forecast, exact redemption value and the roll-over / reinvest decision are Task 1; the calendar is empty until then."
        points={[
          'The CRC-plan bond is not an optimization target and never will be — this calendar reports, it does not suggest selling.',
          'Maturity proceeds land as cash, which your idle-cash rail exists to catch.',
        ]}
        actions={<PendingButton label="Add a maturity" reason="Task 1 — maturity record table ships with the Sammaan forecast" />}
      />
    </>
  );
}