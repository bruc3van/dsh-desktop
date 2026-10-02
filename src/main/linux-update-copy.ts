/** Pure function shared by the settings page, prompt and injected update card. */
export function linuxDownloadInstructions(fileName: string | undefined, chinese: boolean): string {
  if (fileName?.toLowerCase().endsWith('.deb')) {
    return chinese
      ? '已下载并校验。请退出客户端，在下载文件所在目录执行 sudo apt install ./文件名.deb，然后重新打开。关闭窗口仅隐藏到后台，请使用“退出”。'
      : 'Downloaded and verified. Quit the client, run sudo apt install ./filename.deb from the download folder, then reopen. Closing the window only hides it; use Quit.'
  }
  return chinese
    ? '已下载并校验。请退出客户端，手动替换原文件为新 AppImage，再重新打开。'
    : 'Downloaded and verified. Quit, replace the original file manually with the new AppImage, then reopen it.'
}
