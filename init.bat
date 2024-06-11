@REM This script is used to start the printer server
@REM It should be placed in the same directory as the server
@REM The server should be built before running this script

@REM Change to the server directory
cd "printer server directory"

@REM Run the auto update script
node dist/autoupdate/autoupdate.js

@REM run npm install
call npm install

@REM Run the server
node dist/index.js

@REM Wait 5 seconds before restarting
timeout /t 5

@REM call this script again
%0
