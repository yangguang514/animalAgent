const fillerPattern =
  /帮我|请问|请|介绍一下|介绍|顺便说下|说下|一下|什么是|是什么|为什么|怎么|如何|有没有|吗|呢|吧/gu;
const comparePattern = /有什么区别|有啥区别|区别是什么|差异是什么|有什么不同|有啥不同|vs|VS/gu;

export function generateLocalTitle(messages) {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join(" ");

  const cleaned = userText
    .replace(comparePattern, " 区别 ")
    .replace(fillerPattern, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.match(/[\p{Script=Han}]{2,8}|[a-zA-Z0-9]{2,20}/gu) || [];
  return words.slice(0, 3).join("").slice(0, 18) || "动物知识问答";
}
