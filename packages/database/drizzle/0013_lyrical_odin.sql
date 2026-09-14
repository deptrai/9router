ALTER TABLE "admin_alerts" DROP CONSTRAINT IF EXISTS "admin_alerts_type_valid";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplier_product_id" varchar(255);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stock" integer;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "sync_interval_sec" integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "consecutive_sync_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_supplier_product_unique_idx" ON "products" USING btree ("supplier_source_id","supplier_product_id");--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_type_valid" CHECK ("admin_alerts"."type" IN ('PRICE_THRESHOLD_EXCEEDED', 'PRICE_SYNC_FAILED', 'CATALOG_SYNC_FAILED'));--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_sync_interval_valid" CHECK ("supplier_sources"."sync_interval_sec" >= 3600);
