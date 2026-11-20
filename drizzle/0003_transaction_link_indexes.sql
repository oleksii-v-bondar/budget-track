CREATE INDEX "scheduled_subtransaction_scheduled_id" ON "scheduled_subtransaction" USING btree ("scheduled_id");--> statement-breakpoint
CREATE INDEX "subtransaction_transfer_txn_id" ON "subtransaction" USING btree ("transfer_txn_id");--> statement-breakpoint
CREATE INDEX "transaction_transfer_txn_id" ON "transaction" USING btree ("transfer_txn_id");--> statement-breakpoint
CREATE INDEX "transaction_transfer_account_id" ON "transaction" USING btree ("transfer_account_id");--> statement-breakpoint
CREATE INDEX "transaction_scheduled_id" ON "transaction" USING btree ("scheduled_id");