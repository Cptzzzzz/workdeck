import {test,expect,Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
const password=readFileSync(process.env.WORKDECK_TEST_PASSWORD_FILE||'../.secrets/administrator.txt','utf8').trim();
async function login(page:Page){await page.goto('/');await page.getByLabel('用户名').fill('admin');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入工作台'}).click();await expect(page.getByRole('heading',{name:'你的远程工作台.'})).toBeVisible();}
async function type(page:Page,text:string){await page.locator('.terminal-workspace:not(.hidden) .xterm-helper-textarea').focus();await page.keyboard.insertText(text);await page.keyboard.press('Enter');}
async function screen(page:Page,text:string){await expect(page.locator('.terminal-workspace:not(.hidden) .xterm-screen')).toContainText(text);}
test('persistent terminal, mobile resize, readonly and takeover',async({page,browser})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await login(page);await page.screenshot({path:'../test-results/dashboard-desktop.png',fullPage:true});
 await expect(page.locator('.node-item .online')).toHaveCount(1);
 const name='验收终端-'+Date.now();
 await page.getByRole('button',{name:'新建终端',exact:true}).first().click();await page.getByLabel('终端名称').fill(name);await page.getByRole('button',{name:'创建并连接'}).click();
 await expect(page.locator('.terminal-state')).toContainText('控制中');
 await type(page,"export WORKDECK_PERSIST='survived-browser-reconnect'");
 const id=await page.evaluate(()=>fetch('/api/state').then(r=>r.json()).then(s=>s.terminals[0].id));
 await type(page,"printf 'pty-size='; stty size");await screen(page,'pty-size=');
 // Run a real background task, detach the browser, and confirm the same shell and job survive.
 await type(page,"(sleep 2; printf 'background-task-complete\\n' > /tmp/workdeck-e2e-"+id+") &");
 await page.reload();await expect(page.getByRole('heading',{name:'你的远程工作台.'})).toBeVisible();
 await page.getByRole('button',{name}).click();await expect(page.locator('.terminal-state')).toContainText('控制中');
 await type(page,'echo $WORKDECK_PERSIST; cat /tmp/workdeck-e2e-'+id);await screen(page,'survived-browser-reconnect');await screen(page,'background-task-complete');
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mobile=await context.newPage();await login(mobile);await mobile.screenshot({path:'../test-results/dashboard-mobile.png',fullPage:true});
 await mobile.getByRole('button',{name}).click();await expect(mobile.locator('.readonly-banner')).toBeVisible();
 await mobile.getByRole('button',{name:'接管终端'}).click();await expect(mobile.locator('.terminal-state')).toContainText('控制中');await expect(page.locator('.readonly-banner')).toBeVisible();
 await type(mobile,"printf 'mobile-size='; stty size");await screen(mobile,'mobile-size=');
 await mobile.screenshot({path:'../test-results/terminal-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'接管终端'}).click();await expect(page.locator('.terminal-state')).toContainText('控制中');
 await type(page,'echo $WORKDECK_PERSIST');await screen(page,'survived-browser-reconnect');
 await page.screenshot({path:'../test-results/terminal-desktop.png',fullPage:true});
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'终止终端',exact:true}).click();await expect(page.getByRole('heading',{name:'你的远程工作台.'})).toBeVisible();
 await context.close();expect(errors).toEqual([]);
});
