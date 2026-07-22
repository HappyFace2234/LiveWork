export type SidebarBatchDeleteResult = {
  deletedIds: readonly string[];
  failedIds: readonly string[];
};

export async function deleteSidebarConversations(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<boolean>,
): Promise<SidebarBatchDeleteResult> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      if (await deleteOne(id)) {
        deletedIds.push(id);
      } else {
        failedIds.push(id);
      }
    } catch {
      failedIds.push(id);
    }
  }
  return { deletedIds, failedIds };
}
