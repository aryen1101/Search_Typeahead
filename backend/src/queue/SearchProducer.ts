import { Kafka, KafkaJSDeleteGroupsError, Producer } from "kafkajs";
import { Metrics } from "../metrics/Metrics";
import { normalize } from "../db/normalize";
import { log } from "../logger";

export class SearchProducer {
    private producer: Producer;

    constructor(
        kafka: Kafka,
        private topic: string,
        private metrics: Metrics
    ) {
        this.producer = kafka.producer({allowAutoTopicCreation: true})
    }

    async connect() : Promise<void> {
        await this.producer.connect()
        log.info("Kafka producer connected.")
    }

    async record(rawQuery: string): Promise<{message : string}> {
        const q = normalize(rawQuery)
        if(q){
            await this.producer.send({
                topic: this.topic,
                messages:[{key: q, value: q}]
            })
            this.metrics.recordSearch();
        }
        return { message: "Searched" };
    }

    async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}