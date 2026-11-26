import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Windows shared-printer online check, used by checkPrinters and printJob.ts.
// WorkOffline flips False->True within ~10s of powering the printer off.
export const isUSBPrinterOnline = async (
  shareName: string
): Promise<boolean> => {
  const safeShareName = shareName.replace(/'/g, "''");
  const command = `powershell -NoProfile -Command "Get-WmiObject -Query \\"SELECT * FROM Win32_Printer WHERE ShareName = '${safeShareName}'\\" | Select-Object -ExpandProperty WorkOffline"`;
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim().toLowerCase() === 'false';
  } catch {
    return false;
  }
};
