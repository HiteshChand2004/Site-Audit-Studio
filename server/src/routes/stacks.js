import { Router } from 'express';
import { listStacks } from '../recreate/emit/index.js';
import { toolchainStatus } from '../toolchains/index.js';

const router = Router();

// The output stacks and what each needs: status (ready | planned) and, for stacks with a build
// toolchain, whether it is installed (`setup` is the command that installs it).
router.get('/', async (_req, res) => {
  const stacks = await Promise.all(listStacks().map(async (s) => {
    if (!s.toolchain) return { ...s, toolchainInstalled: true };
    const t = await toolchainStatus(s.toolchain);
    return { ...s, toolchainInstalled: t.installed, ...(t.installed ? {} : { setup: t.setup }) };
  }));
  res.json({ stacks });
});

export default router;
