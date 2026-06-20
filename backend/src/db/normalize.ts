export function normalize(input: string | undefined | null) : string {
    if(!input){
        return ""
    }
    return input.toLowerCase().replace(/\s+/g, " ").trim()
}