import { Router, type IRouter } from "express";
import healthRouter from "./health";
import proxyRouter from "./proxy";
import settingsRouter from "./settings";
import updateRouter from "./update";

const router: IRouter = Router();

router.use(healthRouter);
router.use(settingsRouter);
router.use(updateRouter);
router.use(proxyRouter);

export default router;
