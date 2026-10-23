// 1080px 功能声明海报：深蓝头部、浅色正文、两列阅读区；无需外部字体或样式。
export const MENU_RENDER_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  width: 1080px;
  color: #24324a;
  background: #eef3f7;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { padding: 36px; background: radial-gradient(circle at 95% 0%, #e3edf7, transparent 45%), #eef3f7; }
.hero {
  display: flex; align-items: center; justify-content: space-between; gap: 22px;
  padding: 34px 36px; border-radius: 24px;
  color: #fff; background: linear-gradient(120deg, #122943, #234864);
  box-shadow: 0 12px 30px rgba(26, 51, 78, .13);
}
.hero-txt { flex: 1; min-width: 0; }
.eyebrow { font-size: 18px; color: #abcfdf; letter-spacing: 2px; }
.eyebrow span { margin-left: 18px; padding-left: 18px; border-left: 1px solid #53758b; letter-spacing: 0; color: #d1e3ec; }
h1 { margin-top: 18px; font-size: 49px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
h1 span { display: block; margin-top: 6px; font-weight: 400; font-size: 29px; color: #c9e3ef; }
.tagline { margin-top: 18px; font-size: 21px; color: #e0eaf1; }
.avatar { width: 154px; height: 182px; flex: 0 0 154px; object-fit: cover; object-position: top; border-radius: 18px; border: 3px solid #92afc2; background: #e6eef4; }
.intro { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 24px 4px; }
.intro p { font-size: 20px; color: #485d72; }
.intro > span { flex: none; font-size: 16px; padding: 7px 12px; border: 1px solid #cbd9e3; border-radius: 6px; color: #537084; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: stretch; }
.card { padding: 25px 26px 23px; border: 1px solid #d9e4ec; border-radius: 18px; background: #fff; box-shadow: 0 5px 12px rgba(26, 51, 78, .035); }
.card-hd { display: flex; align-items: center; gap: 13px; }
.number { font-size: 18px; line-height: 34px; width: 37px; text-align: center; font-weight: 700; color: #347083; background: #eaf3f5; border-radius: 8px; }
.card-hd h2 { font-size: 26px; font-weight: 700; color: #19374d; }
.note { margin: 12px 0 10px; padding-bottom: 16px; border-bottom: 1px solid #e6edf2; color: #60758a; font-size: 18px; line-height: 1.5; }
.items { list-style: none; }
.item { display: block; padding-top: 14px; }
.item .k { display: block; color: #2a5f75; font-size: 20px; font-weight: 700; line-height: 1.45; }
.item .v { display: block; margin-top: 3px; font-size: 20px; line-height: 1.55; color: #43566a; overflow-wrap: anywhere; }
.foot { margin-top: 23px; padding: 20px 23px; border-left: 4px solid #4f899c; background: #e2edf1; border-radius: 0 12px 12px 0; }
.call { font-size: 21px; font-weight: 600; color: #244a5f; }
.limit { font-size: 18px; margin-top: 9px; color: #506d7e; }
`;
