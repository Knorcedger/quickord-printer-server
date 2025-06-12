import { getSettings } from './modules/settings';

export const homepage = () => {
  return `<div style="padding: 12px;">
      <p style="font-weight: bold;">
        This is the homepage of the printer controller
      </p>
      <div>
        To change the settings, please visit <a href="https://app.quickord.com/venue/id/printer-settings">quickord</a>.
        <br />
        <br />
        <br />
        The current settings are:
        <div style="white-space: pre-wrap;">
${JSON.stringify(getSettings(), null, 2)}
        </div>
      </div>
    </div>`;
};
