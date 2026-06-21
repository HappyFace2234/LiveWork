import type { ReactNode } from "react";
import { FolderTree, GitBranch, Globe, Key } from "../icons";
import type { RightDockSingletonTabKind } from "./rightDockModel";

export type { RightDockSingletonTabKind } from "./rightDockModel";

export type RightDockToolDefinition = {
  kind: RightDockSingletonTabKind;
  titleKey: string;
  createTitleKey: string;
  descriptionKey: string;
  closeKey: string;
  projectRequired: boolean;
  icon: (className: string) => ReactNode;
};

export const RIGHT_DOCK_TOOL_DEFINITIONS: readonly RightDockToolDefinition[] = [
  {
    kind: "fileTree",
    titleKey: "projectTools.fileTreeTitle",
    createTitleKey: "projectTools.newFileTree",
    descriptionKey: "projectTools.fileTreeDescription",
    closeKey: "projectTools.closeFileTree",
    projectRequired: true,
    icon: (className) => <FolderTree className={className} />,
  },
  {
    kind: "gitReview",
    titleKey: "projectTools.gitReviewTitle",
    createTitleKey: "projectTools.newGitReview",
    descriptionKey: "projectTools.gitReviewDescription",
    closeKey: "projectTools.closeGitReview",
    projectRequired: true,
    icon: (className) => <GitBranch className={className} />,
  },
  {
    kind: "tunnel",
    titleKey: "projectTools.tunnelTitle",
    createTitleKey: "projectTools.newTunnel",
    descriptionKey: "projectTools.tunnelDescription",
    closeKey: "projectTools.closeTunnelTab",
    projectRequired: false,
    icon: (className) => <Globe className={className} />,
  },
  {
    kind: "sshTunnel",
    titleKey: "projectTools.sshTunnelTitle",
    createTitleKey: "projectTools.newSshTunnel",
    descriptionKey: "projectTools.sshTunnelDescription",
    closeKey: "projectTools.closeSshTunnelTab",
    projectRequired: true,
    icon: (className) => <Key className={className} />,
  },
];

const RIGHT_DOCK_TOOL_DEFINITION_BY_KIND = new Map(
  RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

export function getRightDockToolDefinition(kind: RightDockSingletonTabKind) {
  return RIGHT_DOCK_TOOL_DEFINITION_BY_KIND.get(kind);
}
