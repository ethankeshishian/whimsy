// Loaded once per browser window: DOM modules must use its module loader.
import { WhimsyNotesSection } from "./whimsy-library-notes.mjs";
import { WhimsyFinderFoldersSection } from "./whimsy-library-finderfolders.mjs";
import { WhimsyFilesSection } from "./whimsy-library-files.mjs";
import { WhimsyNextMeetingSection } from "./whimsy-library-next-meeting.mjs";
import { WhimsySpaceHistorySection } from "./whimsy-library-space-history.mjs";
import { WhimsyArchiveSection } from "./whimsy-library-archive.mjs";
import { WhimsyPlaylistSection } from "./whimsy-library-playlist.mjs";
const { WhimsyLibrarySection } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyLibrarySection.sys.mjs"
);
WhimsyLibrarySection.registerWindow(window, {
  WhimsyNotesSection, WhimsyFinderFoldersSection, WhimsyFilesSection,
  WhimsyNextMeetingSection, WhimsySpaceHistorySection,
  WhimsyArchiveSection, WhimsyPlaylistSection,
});
