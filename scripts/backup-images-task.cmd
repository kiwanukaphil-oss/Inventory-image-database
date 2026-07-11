@echo off
rem Scheduled-task wrapper for the nightly product-image backup.
rem Task Scheduler gives no working directory, so cd into the repo first;
rem output goes to task-run.log next to the backup so failures are visible.
cd /d "c:\Projects\Images\Inventory image database"
call npm run backup:images >> "%USERPROFILE%\OneDrive\Backups\klinemen-product-images\task-run.log" 2>&1
