CREATE INDEX "orders_status_created_at_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "supplier_orders_status_idx" ON "supplier_orders" USING btree ("status");--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_cost_non_negative" CHECK ("supplier_orders"."cost" IS NULL OR "supplier_orders"."cost" >= 0);