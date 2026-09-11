CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'WARN' NOT NULL,
	"product_id" uuid,
	"supplier_source_id" uuid,
	"message" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "admin_alerts_type_valid" CHECK ("admin_alerts"."type" IN ('PRICE_THRESHOLD_EXCEEDED', 'PRICE_SYNC_FAILED'))
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplier_product_url" varchar(512);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "upstream_cost" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_upstream_cost" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "auto_pricing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD COLUMN "markup_fixed_vnd" numeric(15, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_supplier_source_id_supplier_sources_id_fk" FOREIGN KEY ("supplier_source_id") REFERENCES "public"."supplier_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_alerts_type_idx" ON "admin_alerts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "admin_alerts_created_at_idx" ON "admin_alerts" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_max_upstream_cost_valid" CHECK ("products"."max_upstream_cost" IS NULL OR "products"."max_upstream_cost" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_upstream_cost_valid" CHECK ("products"."upstream_cost" IS NULL OR "products"."upstream_cost" >= 0);--> statement-breakpoint
ALTER TABLE "supplier_sources" ADD CONSTRAINT "supplier_markup_fixed_non_negative" CHECK ("supplier_sources"."markup_fixed_vnd" >= 0);