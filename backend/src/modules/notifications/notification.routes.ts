import { Hono } from "hono";
import { NotificationModule } from "./notification.module";

export const notificationRoutes = new Hono();

const notifications =
  new NotificationModule().notifications;

  notificationRoutes.get(
  "/businesses/:id/notifications",
  async (c) => {

    return c.json(

      await notifications.getBusinessSettings(

        c.req.param("id"),

      ),

    );

  },
);

notificationRoutes.patch(
  "/businesses/:id/notifications",
  async (c) => {

    await notifications.updateBusinessSettings(

      c.req.param("id"),

      await c.req.json(),

    );

    return c.json({
      success: true,
    });

  },
);