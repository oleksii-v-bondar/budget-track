DROP TABLE "login_attempt" CASCADE;--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "totp_secret_enc";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "recovery_code_hashes";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "totp_last_step";